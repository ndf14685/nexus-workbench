# Firma del instalador

## Qué resuelve

Firmar el `.exe` deja dos cosas demostrables para quien lo instala:

1. **quién lo construyó** — no qué servidor lo sirvió, sino quién se hace responsable
2. **que llegó igual que como salió** — nadie le insertó nada en el camino

En la práctica, para este fork:

- se va el cartel de "editor desconocido" al instalar
- `verifyUpdateCodeSignature` puede prenderse, y entonces el auto-updater
  comprueba que la actualización esté firmada por `publisherName` **antes de
  ejecutarla**

Sobre lo segundo, siendo preciso con lo que suma: el update ya viaja por HTTPS
y `electron-updater` valida el sha512 del `.yml`, así que contra un MITM ya
había cobertura. Lo que la firma agrega es el caso de **alguien con acceso de
escritura al repositorio publicando un release falso**: sin la clave privada no
lo puede firmar y la app lo rechaza.

## Por qué autofirmado

Un certificado comercial lo emite una CA (DigiCert, Sectigo, SSL.com,
GlobalSign) después de validar identidad legal, contra pago anual, y desde
junio de 2023 la clave privada tiene que vivir en hardware certificado: un token
USB por correo o un HSM en la nube del CA. Azure Trusted Signing —la opción
barata— no valida identidad en Argentina.

Como el único que instala esta app es su autor, un certificado autofirmado da
los dos beneficios de arriba por cero pesos. Lo que **no** da es confianza en
máquinas de terceros: ahí sigue apareciendo como no confiable, porque nadie
validó la identidad. Es la diferencia real entre autofirmado y comprado.

## Puesta en marcha

En PowerShell **como Administrador**, en la máquina donde se usa el Workbench:

```powershell
.\nexus\scripts\new-signing-cert.ps1 -Subject "Nestor Fleitas"
```

Eso genera el certificado, lo confía en esa máquina (`Root` y
`TrustedPublisher`) y escupe lo que hay que cargar en GitHub:

| dónde | nombre | qué es |
|---|---|---|
| secret | `WIN_CSC_LINK` | el `.pfx` en base64 |
| secret | `WIN_CSC_KEY_PASSWORD` | la contraseña del `.pfx` |
| variable | `NEXUS_PUBLISHER_NAME` | el mismo `-Subject` |

Se cargan en **Settings → Secrets and variables → Actions**. Desde el próximo
tag, el instalador sale firmado y con verificación de update prendida.

`NEXUS_PUBLISHER_NAME` **tiene que coincidir** con el subject del certificado:
`electron-updater` compara ambos y, si difieren, rechaza todas las
actualizaciones. El workflow lo valida después de empaquetar para que eso falle
en CI y no en la máquina del usuario.

### En cada máquina adicional

El certificado hay que confiarlo en cada Windows donde se instale la app, o el
updater va a rechazar sus propias actualizaciones. Con el `.cer` que queda en
`.signing\`:

```powershell
Import-Certificate -FilePath .\.signing\nexus-codesign.cer -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath .\.signing\nexus-codesign.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
```

## El compromiso de tener la clave en GitHub

Poner el `.pfx` en los secrets de Actions **debilita justamente la protección
que motivaba firmar**: quien comprometa la cuenta de GitHub puede correr un
workflow que firme un build malicioso. Los secrets no son legibles de forma
directa, pero un workflow malicioso los usa igual.

Las opciones, según cuánto importe ese escenario:

- **Firmar en CI** (lo implementado): cómodo, protege contra manipulación de los
  assets del release, no contra un compromiso total de la cuenta.
- **Firmar localmente**: la clave nunca sale de la máquina. Hay que empaquetar y
  firmar a mano en cada release. Es lo que corresponde si el escenario de cuenta
  comprometida es el que preocupa.

## Sin certificado

Si los secrets no existen, no se firma, `verifyUpdateCodeSignature` queda
apagado —prenderlo sin firma haría que el updater rechace su propio artefacto y
ninguna actualización se instale— y la release sigue publicando
`SHA256SUMS.txt` para verificar a mano.

## Si algún día hay un certificado comercial

El cableado sirve igual. Con un `.pfx` de una CA, se reemplazan los mismos dos
secrets. Con un HSM en la nube por thumbprint (DigiCert KeyLocker), se usa
`SM_CODE_SIGNING_CERT_SHA1_HASH` y la config busca el certificado en el almacén
por subject. Las dos vías están contempladas en `electron-builder.config.cjs`.
