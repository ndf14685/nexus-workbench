# Aprobación humana fuera de banda

## El problema

El gate en dos fases le devuelve el `confirm_token` al propio agente y le pide
que consulte al usuario antes de reusarlo. Eso es un sistema de honor, y el
agente es exactamente la parte cuya obediencia no queremos tener que asumir.

## Cómo funciona

Con `--approvals <dir>`, las acciones de mayor riesgo dejan de darle token al
agente. En su lugar:

1. El Workbench publica `<dir>/<id>.json` con la acción, el ambiente y el
   motivo. El detalle va **redactado**: lo va a leer una persona por un canal
   externo, y un secreto en un mensaje de Telegram es un secreto filtrado.
2. El agente sólo recibe el `id` y la instrucción de avisarle al usuario y
   consultar con `check_approval`.
3. Una persona aprueba o rechaza creando un archivo marcador:

   ```bash
   touch  <dir>/<id>.approved   # aprobar
   touch  <dir>/<id>.denied     # rechazar
   ```

4. El agente repite la llamada original pasando el `id` como `confirm_token`.
   Recién ahí se ejecuta, y el marcador se consume: no sirve para una segunda
   ejecución.

Si aparecen las dos marcas, gana la denegación. Sin respuesta, la solicitud
expira a los 10 minutos.

## Qué sale de la conversación

No todo lo que pide confirmación: un ambiente `work` de rutina sigue con el
flujo en dos fases. Sale de banda lo irreversible o lo que toca producción:

- `class: prod`
- contexto efectivo que parece producción (ver el guardia de contexto)
- runbooks marcados `destructive: true`
- comandos que disparan los patrones destructivos

## Puente a Telegram / OpenClaw

El contrato es el directorio, no el transporte. OpenClaw ya tiene el lado
humano de Telegram, así que el puente es un watcher sobre `<dir>`:

- aparece un `*.json` → mandar el mensaje al topic con la acción y el id
- respuesta "ok <id>" → `touch <id>.approved`
- respuesta "no <id>" → `touch <id>.denied`

Nada del Workbench necesita credenciales de Telegram, y cualquier otro canal
(un botón en la app, un webhook, una guardia) sirve igual sin cambiar el
Workbench.

## Sin el flag

Si no se pasa `--approvals`, el comportamiento es el de siempre: confirmación
en dos fases con el token en la conversación.
