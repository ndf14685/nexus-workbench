@.kilocode/rules/rules.md

---

## Sobre `rules.md`

Ese archivo lo comparten Kilocode y Claude Code, por eso no está reorganizado.
Casi todo aplica siempre (convenciones Go/TypeScript, styling, comment rules,
directory awareness, no correr `go build`). Dos secciones están escritas para
Kilocode y hay que **traducirlas**, no ejecutarlas literalmente:

| Sección de `rules.md` | Cómo leerla en Claude Code |
|---|---|
| `### Tool Use` (`write_to_file`, `replace_in_file`, `append_file`) | Esas herramientas no existen acá. La intención sí aplica: usar `Edit` sobre `Write`, y si un diff falla, **re-leer el archivo** y rehacer el diff en vez de reescribir el archivo entero. |
| `### Notes` → `attempt_completion`, `"Done: [one-line description]"`, "Ask mode" | No hay `attempt_completion` ni modos. La intención sí aplica: cerrar con una línea, sin recaps ni resúmenes largos de lo que se cambió. |

---

## Skill Guides

This project uses a set of "skill" guides — focused how-to documents for common implementation tasks. When your task matches one of the descriptions below, **read the linked SKILL.md file before proceeding** and follow its instructions precisely.

| Skill               | File                                              | Description                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| add-config          | `.kilocode/skills/add-config/SKILL.md`            | Guide for adding new configuration settings to Wave Terminal. Use when adding a new setting to the configuration system, implementing a new config key, or adding user-customizable settings.                                               |
| add-rpc             | `.kilocode/skills/add-rpc/SKILL.md`               | Guide for adding new RPC calls to Wave Terminal. Use when implementing new RPC commands, adding server-client communication methods, or extending the RPC interface with new functionality.                                                 |
| add-wshcmd          | `.kilocode/skills/add-wshcmd/SKILL.md`            | Guide for adding new wsh commands to Wave Terminal. Use when implementing new CLI commands, adding command-line functionality, or extending the wsh command interface.                                                                      |
| context-menu        | `.kilocode/skills/context-menu/SKILL.md`          | Guide for creating and displaying context menus in Wave Terminal. Use when implementing right-click menus, adding context menu items, creating submenus, or handling menu interactions with checkboxes and separators.                      |
| create-view         | `.kilocode/skills/create-view/SKILL.md`           | Guide for implementing a new view type in Wave Terminal. Use when creating a new view component, implementing the ViewModel interface, registering a new view type in BlockRegistry, or adding a new content type to display within blocks. |
| electron-api        | `.kilocode/skills/electron-api/SKILL.md`          | Guide for adding new Electron APIs to Wave Terminal. Use when implementing new frontend-to-electron communications via preload/IPC.                                                                                                         |
| jotai-model-pattern | `.claude/skills/jotai-model-pattern/SKILL.md`     | Guide for model classes that hold Jotai atoms. Use when creating or modifying a model, adding state to a view model, wiring derived atoms, or deciding between field-initializer and constructor atoms.                                     |
| waveenv             | `.kilocode/skills/waveenv/SKILL.md`               | Guide for creating WaveEnv narrowings in Wave Terminal. Use when writing a named subset type of WaveEnv for a component tree, documenting environmental dependencies, or enabling mock environments for preview/test server usage.          |
| wps-events          | `.kilocode/skills/wps-events/SKILL.md`            | Guide for working with Wave Terminal's WPS (Wave PubSub) event system. Use when implementing new event types, publishing events, subscribing to events, or adding asynchronous communication between components.                            |
