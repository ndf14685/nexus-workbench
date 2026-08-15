// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Acceso al motor Wave: resolución de directorios, lectura de la clave JWT
// persistida en waveterm.db (db_mainserver), acuñado de tokens y ejecución de
// subcomandos wsh autenticados. No modifica nada del motor: solo lee la DB
// (query de solo lectura) y habla por las superficies públicas (wsh).
package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	_ "modernc.org/sqlite"
)

const (
	JwtIssuer      = "waveterm"
	JwtTTL         = 10 * time.Minute
	WshTimeout     = 30 * time.Second
	DomainSockName = "wave.sock"
)

type WaveAccess struct {
	DataDir string
	WshPath string
	privKey ed25519.PrivateKey
}

// Claims replica pkg/wavejwt.WaveJwtClaims del motor.
type WaveClaims struct {
	jwt.RegisteredClaims
	Sock      string `json:"sock,omitempty"`
	RouteId   string `json:"routeid,omitempty"`
	ProcRoute bool   `json:"procroute,omitempty"`
	BlockId   string `json:"blockid,omitempty"`
	Conn      string `json:"conn,omitempty"`
	Router    bool   `json:"router,omitempty"`
}

func ResolveDataDir(explicit string, dev bool) string {
	if explicit != "" {
		return explicit
	}
	if v := os.Getenv("WAVETERM_DATA_HOME"); v != "" {
		return v
	}
	name := "waveterm"
	if dev {
		name = "waveterm-dev"
	}
	if v := os.Getenv("XDG_DATA_HOME"); v != "" {
		return filepath.Join(v, name)
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, name, "Data")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", name)
	default:
		return filepath.Join(home, ".local", "share", name)
	}
}

func ResolveWshPath(explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if v := os.Getenv("NEXUS_WSH_PATH"); v != "" {
		return v, nil
	}
	if p, err := exec.LookPath("wsh"); err == nil {
		return p, nil
	}
	var globs []string
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		globs = []string{
			filepath.Join(base, "Programs", "waveterm", "resources", "app.asar.unpacked", "dist", "bin", "wsh-*-windows.x64.exe"),
			filepath.Join(base, "Programs", "nexus-workbench", "resources", "app.asar.unpacked", "dist", "bin", "wsh-*-windows.x64.exe"),
		}
	} else {
		globs = []string{
			filepath.Join(home, ".waveterm", "bin", "wsh"),
			"/opt/Nexus Workbench/resources/app.asar.unpacked/dist/bin/wsh-*",
		}
	}
	for _, g := range globs {
		matches, _ := filepath.Glob(g)
		if len(matches) > 0 {
			return matches[len(matches)-1], nil
		}
	}
	return "", fmt.Errorf("no se encontró el binario wsh; usar --wsh o NEXUS_WSH_PATH")
}

func MakeWaveAccess(dataDir string, wshPath string) (*WaveAccess, error) {
	wa := &WaveAccess{DataDir: dataDir, WshPath: wshPath}
	if err := wa.loadPrivateKey(); err != nil {
		return nil, err
	}
	return wa, nil
}

func (wa *WaveAccess) dbPath() string {
	return filepath.Join(wa.DataDir, "db", "waveterm.db")
}

func (wa *WaveAccess) SockPath() string {
	return filepath.Join(wa.DataDir, DomainSockName)
}

func (wa *WaveAccess) openDB() (*sql.DB, error) {
	p := wa.dbPath()
	if _, err := os.Stat(p); err != nil {
		return nil, fmt.Errorf("no existe %s — ¿la app corrió al menos una vez en esta máquina?", p)
	}
	return sql.Open("sqlite", "file:"+p+"?mode=ro&_pragma=busy_timeout(3000)")
}

func (wa *WaveAccess) loadPrivateKey() error {
	db, err := wa.openDB()
	if err != nil {
		return err
	}
	defer db.Close()
	var data string
	err = db.QueryRow("SELECT data FROM db_mainserver LIMIT 1").Scan(&data)
	if err != nil {
		return fmt.Errorf("leyendo db_mainserver: %w", err)
	}
	var ms struct {
		JwtPrivateKey string `json:"jwtprivatekey"`
	}
	if err := json.Unmarshal([]byte(data), &ms); err != nil {
		return fmt.Errorf("parseando mainserver: %w", err)
	}
	if ms.JwtPrivateKey == "" {
		return fmt.Errorf("db_mainserver sin jwtprivatekey (¿versión vieja del motor?)")
	}
	raw, err := base64.StdEncoding.DecodeString(ms.JwtPrivateKey)
	if err != nil {
		return fmt.Errorf("decodificando clave: %w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return fmt.Errorf("clave privada con tamaño inesperado: %d", len(raw))
	}
	wa.privKey = ed25519.PrivateKey(raw)
	return nil
}

// ActiveTabId devuelve el tab activo del workspace indicado (o del primero).
func (wa *WaveAccess) ActiveTabId(workspaceName string) (string, error) {
	db, err := wa.openDB()
	if err != nil {
		return "", err
	}
	defer db.Close()
	rows, err := db.Query("SELECT data FROM db_workspace")
	if err != nil {
		return "", fmt.Errorf("leyendo workspaces: %w", err)
	}
	defer rows.Close()
	type wsData struct {
		Name        string `json:"name"`
		ActiveTabId string `json:"activetabid"`
	}
	var first string
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			continue
		}
		var ws wsData
		if json.Unmarshal([]byte(data), &ws) != nil {
			continue
		}
		if ws.ActiveTabId == "" {
			continue
		}
		if first == "" {
			first = ws.ActiveTabId
		}
		if workspaceName != "" && strings.EqualFold(ws.Name, workspaceName) {
			return ws.ActiveTabId, nil
		}
	}
	if workspaceName != "" {
		return "", fmt.Errorf("workspace %q no encontrado", workspaceName)
	}
	if first == "" {
		return "", fmt.Errorf("no hay workspaces con tab activo (¿app abierta?)")
	}
	return first, nil
}

func (wa *WaveAccess) MintJWT(conn string) (string, error) {
	now := time.Now()
	claims := &WaveClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    JwtIssuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(JwtTTL)),
		},
		Sock:      wa.SockPath(),
		ProcRoute: true,
		Conn:      conn,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	return token.SignedString(wa.privKey)
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>]|\r`)

func stripAnsi(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

func tailLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// RunWsh ejecuta un subcomando wsh autenticado. conn setea el contexto de
// conexión del JWT (los bloques nuevos heredan esa conexión); tabId es
// necesario para comandos que crean bloques.
// las conexiones del catálogo pueden no estar establecidas en la app; sin esto el
// bloque remoto se crea pero su controller nunca arranca (CheckConnStatus falla y el
// error solo llega a la consola del frontend)
func (wa *WaveAccess) EnsureConnection(ctx context.Context, conn string, tabId string) error {
	if conn == "" {
		return nil
	}
	_, err := wa.RunWsh(ctx, "", tabId, "conn", "connect", conn)
	return ignoreAlreadyConnected(err)
}

// Connect del conncontroller rechaza el pedido solo cuando el estado ya es
// "connected" o "connecting"; para "asegurar la conexión" ambos son éxito.
func ignoreAlreadyConnected(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, `when status is "connected"`) || strings.Contains(msg, `when status is "connecting"`) {
		return nil
	}
	return err
}

func (wa *WaveAccess) RunWsh(ctx context.Context, conn string, tabId string, args ...string) (string, error) {
	token, err := wa.MintJWT(conn)
	if err != nil {
		return "", fmt.Errorf("acuñando JWT: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, WshTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, wa.WshPath, args...)
	cmd.Env = append(os.Environ(),
		"WAVETERM_JWT="+token,
		"WAVETERM_TABID="+tabId,
	)
	out, err := cmd.CombinedOutput()
	sout := strings.TrimSpace(string(out))
	if err != nil {
		return sout, fmt.Errorf("wsh %s: %v — %s", strings.Join(args, " "), err, sout)
	}
	return sout, nil
}
