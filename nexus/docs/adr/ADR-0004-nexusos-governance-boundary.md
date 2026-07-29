# ADR-0004: Frontera de gobernanza con NexusOS

- Estado: Aceptada
- Fecha: 2026-07-28

## Contexto

NexusOS aportará en el futuro identidad, autorización, policy, análisis de
riesgo, ejecución gobernada y auditoría. Nexus Workbench debe poder integrarse
con eso, pero la primera versión usable no puede depender de que NexusOS
exista, esté desplegado o sea alcanzable.

## Decisión

1. **NexusOS es opcional por diseño.** Nexus Workbench funciona al 100% sin
   NexusOS presente. Ninguna ruta de código del MVP consulta servicios de
   NexusOS.
2. El punto de integración futuro es el **Workbench Bridge** (ADR-0002): las
   operaciones del bridge (`runCommand`, `openConnection`, restore de
   workspaces) son el lugar natural para interponer policy/audit hooks cuando
   NexusOS exista. Hoy esos hooks no se implementan; solo se reserva el punto
   de corte en el contrato.
3. El catálogo de ambientes (`nexus/config/environments*.yaml`) incluye el
   campo `class` (`lab | personal | work | prod`) y `criticality`. Esa
   metadata es la semilla del modelo de riesgo de NexusOS, pero hoy solo se
   usa para distinción visual y confirmaciones locales.
4. No se almacena identidad, tokens ni credenciales propias: autenticación SSH
   delegada a ssh-agent / claves del sistema (ver `SECURITY.md`).
5. Los repositorios de NexusOS no se tocan desde este proyecto.

## Consecuencias

- (+) El MVP no queda bloqueado por infraestructura inexistente.
- (+) La integración futura tiene un punto de corte único y documentado.
- (−) Hasta esa integración, las confirmaciones de comandos privilegiados son
  locales y simples (class=prod ⇒ confirmar), sin policy centralizada.
