# Nexus Workbench — Catálogo de ambientes y administrador de conexiones

Un "ambiente" es un servidor (o una shell local/WSL) del catálogo. Vive en la
clave `nexus:environments` de `settings.json` y se dibuja en la sidebar
izquierda (D-020).

Hay **dos caminos** para poblar ese catálogo, y desde D-030 el primario es la UI:

| Camino | Cuándo | Qué escribe |
|---|---|---|
| **Administrador en la app** (primario) | uso diario: alta, edición, duplicado, borrado de servidores | `settings.json` + `connections.json` + secret store |
| **Importador YAML** (bootstrap opcional) | provisionar una máquina nueva desde un catálogo versionado | lo mismo, más `widgets.json` y `presets.json` |

Los dos producen **la misma forma**. No hay un formato "de la UI" y otro "del
importador": `frontend/app/nexus/env-store.ts` y
`nexus/scripts/import-environments.mjs` emiten las mismas claves con los mismos
valores, y hay tests que lo fijan (`env-store.test.ts`).

## El administrador (camino primario)

Sidebar de ambientes → botón **+** ("Nuevo servidor"), o menú contextual de un
ambiente → **Editar… / Duplicar / Eliminar**.

Un solo formulario: Nombre, Host, Puerto, Usuario, Método de autenticación
(Clave / Contraseña / Agente), Clave privada, Contraseña, Descripción, Grupo,
Color, Ícono, Comando inicial y el toggle de integración wsh. Sin YAML, sin
reiniciar la app (el watcher de config empuja el cambio en caliente).

### Contraseñas: almacén del SO, nunca la configuración

Cuando el método es **Contraseña**, el valor va al **secret store cifrado**
(`pkg/secretstore`, cifrado por `safeStorage` de Electron — DPAPI en Windows,
kwallet/libsecret en Linux) bajo el nombre derivado `nexus_ssh_<id-saneado>`, y
a `connections.json` viaja **solo el nombre**:

```jsonc
// connections.json
"ndf@192.168.50.105": {
    "display:order": 0,
    "term:theme": "dracula",
    "ssh:user": "ndf",
    "ssh:passwordsecretname": "nexus_ssh_rig3060"   // ← el NOMBRE, no la clave
}
```

`pkg/remote/sshclient.go` resuelve ese nombre contra el store en cada conexión.
La contraseña **no** está en `settings.json`, **no** está en `connections.json`
y **no** está en el catálogo de ambientes.

Reglas de ciclo de vida:

- Al editar, el campo muestra `••••• (guardada)` y **solo se sobrescribe si
  escribís algo**. Dejarlo vacío conserva la contraseña guardada.
- Cambiar de método (a Clave o Agente) **borra** el secreto y deja de
  referenciarlo.
- Eliminar el ambiente borra el secreto.
- **Duplicar no clona la contraseña**: el secreto está bajo el id del original y
  copiarlo exigiría leer el valor en claro. La copia abre con el campo vacío.

El nombre del secreto se deriva del **id** (estable), no del nombre visible, para
que renombrar un servidor no pierda su contraseña. La derivación satisface por
construcción el regex del store (`^[A-Za-z][A-Za-z0-9_]*$`): prefijo fijo
`nexus_ssh_` + el id con todo lo que no sea `[A-Za-z0-9_]` reemplazado por `_`.

## Claves que se escriben en `connections.json`

Estas son las claves **propias** de ambos caminos:

`display:order` · `term:theme` · `ssh:user` · `ssh:port` · `ssh:identityfile` ·
`ssh:passwordsecretname` · `conn:wshenabled` · `cmd:initscript`

Dos omisiones deliberadas, por la misma razón — en la cascada de keywords
`connections.json` **le gana** a `~/.ssh/config`, así que escribir un default
equivale a clavarlo:

- **Nunca se emite `ssh:hostname`.** Solo podría valer lo mismo que el nombre de
  la conexión, que es lo que el backend ya deriva por defecto; escribirlo dejaría
  un alias con `HostName 10.0.0.5` pineado a su propio literal.
- **El puerto 22 del formulario es un default, no una declaración**: no se
  escribe `ssh:port`. Si no, un alias con `Port 2222` en `~/.ssh/config` quedaría
  pisado por el 22 que el formulario muestra sin que el usuario lo haya tipeado.
  Como efecto secundario, pegar `user@host:2222` en el campo Host funciona sin
  tener que copiar el puerto al campo Puerto.

La UI escribe las claves propias **siempre**, con `null` cuando no aplican.
No es adorno: `SetConnectionsConfigValue` (`pkg/wconfig/settingsconfig.go`) solo
**mergea** — omitir una clave dejaría pegado el valor anterior, y pasar de
Contraseña a Clave seguiría mandando `ssh:passwordsecretname`.

> **Limitación conocida.** `SetConnectionsConfigCommand` no puede borrar una
> clave ni una entrada de host: solo mergea. Al eliminar un ambiente, la UI anula
> sus claves propias, pero la entrada del host **queda** en `connections.json`
> con valores `null` (inertes: el unmarshal a `ConnKeywords` los lee como campo
> ausente). Borrarla del todo requiere editar el archivo a mano.

## Convivencia entre la UI y el importador

Los dos escriben en las mismas claves. La regla es **propiedad por id**:

- El importador es dueño **solo de los ids que declara su catálogo**. Los
  sobrescribe en cada corrida.
- **Los ambientes creados desde la app se preservan**: el importador los detecta
  por id y los reinyecta en `nexus:environments` (quedan al final de la lista).
  Antes de D-030 el importador asignaba `settings["nexus:environments"]` con el
  resultado de su `.map()`, lo que **borraba en silencio cada servidor dado de
  alta desde la UI**. Verificado con una corrida real: un ambiente
  `creado-en-la-app` sobrevive a la reimportación del catálogo.
- En `connections.json` el importador mergea por clave (`{...connections[key]}`),
  así que las claves que él no emite —`cmd:initscript`,
  `ssh:passwordsecretname`— **sobreviven** aunque el YAML declare esa misma
  conexión. Verificado con una corrida real.
- Los widgets `nexus-env-*` los genera **solo** el importador (se borran y
  regeneran en cada corrida). La UI no crea widgets: en el fork la sidebar es la
  lista de conexiones (D-020), y la barra derecha filtra `nexus-env-*` cuando la
  sidebar está activa.

Si un id existe en el YAML **y** fue editado desde la UI, gana el YAML en la
próxima importación. Es intencional: el catálogo versionado es la fuente de
verdad de lo que declara. Para que un servidor sea "de la UI", no lo pongas en el
YAML.

## Agrupación en la sidebar

El campo `group` explícito manda. Sin `group`, se cae al grupo derivado de `kind`
(Local para local/wsl, Servidores para ssh, Otros para el resto), que es el
comportamiento previo a D-030 y no regresiona. Los grupos propios se listan
primero en orden de aparición; los derivados cierran en su orden canónico.

## Qué no se puede probar sin la máquina del usuario

El round-trip real del secret store **requiere Electron**: el cifrado ocurre en
el proceso main (`emain/emain-wsh.ts`, `safeStorage`) y `pkg/secretstore` lo
llama por RPC con `Route: electron`. Fuera de la app (tests headless, CI) esa
ruta no existe. La lógica de la UI está cubierta con el RPC mockeado —
qué comando se manda, con qué nombre y con qué valor— pero **que la contraseña
se cifre, persista en `secrets.enc` y vuelva en el siguiente login SSH solo se
puede confirmar corriendo la app**.
