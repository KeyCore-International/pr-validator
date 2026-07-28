# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/): los tags `vX.Y.Z` son inmutables
y el tag `vX` se mueve al último release de ese major.

## [2.0.2] — 2026-07-28

### Corregido

- El paso que emite el veredicto como job output usaba `cat`, y `run-check`
  escribe `verdict.json` **sin salto de línea final**. La llave de cierre y el
  delimitador quedaban en la misma línea, el runner rechazaba el archivo de
  outputs entero —*«Invalid value. Matching delimiter not found»*— y los tres
  checks salían en rojo con el comentario diciendo «sin resultado».

  Ahora `printf '%s\n' "$(cat verdict.json)"`: la sustitución de comandos quita
  los saltos finales y `printf` repone exactamente uno, que es lo que exige el
  formato de heredoc de `GITHUB_OUTPUT`.

- La cabecera del reusable workflow todavía sugería `secrets: inherit`, el
  consejo que rompía la instalación entre organizaciones. Corregida.

## [2.0.1] — 2026-07-28

### Corregido

- Los veredictos ya no viajan como artifacts. Subirlos consumía almacenamiento
  de Actions, y una organización que agotó su cuota vio los tres checks en rojo
  —`Artifact storage quota has been hit`— sin comentario que explicara nada.
  Una cuota llena no es un problema del código y no puede bloquear un merge.

  Ahora cada instancia de la matriz emite su veredicto como job output y el job
  `report` reconstruye el directorio. El gate deja de consumir almacenamiento y
  deja de depender de él. `report.mjs` no cambia.

  **Para quien añada un check:** hay que declarar su output en
  `jobs.checks.outputs`. Es el único punto donde un check nuevo toca el
  workflow; los nombres de output no se pueden calcular.

- Los ejemplos de instalación usaban `secrets: inherit`, que **solo propaga
  cuando quien llama y el workflow llamado están en la misma organización o
  enterprise**. Este validador vive en una organización distinta a la de casi
  todos sus consumidores, así que con `inherit` no llegaba ninguna credencial y
  el gate se quejaba de un secret ausente que sí existía. Los ejemplos ahora
  pasan cada secret nombrado, y `AGENTS.md` lo registra como trampa conocida
  para que nadie los "simplifique" de vuelta.

- `AI_GATEWAY_API_KEY` pasa a `required: false` en la firma del reusable
  workflow. Con `required: true`, un repositorio sin el secret no llegaba a
  ejecutar nada: GitHub rechazaba la llamada con *«Secret AI_GATEWAY_API_KEY is
  required, but not provided»* y todos los jobs salían en rojo, sin comentario
  que explicara nada. Justo el desenlace que este gate promete no producir.

  Declarado opcional, los checks corren y `run-check` reporta la ausencia como
  error de herramienta: advertencia visible que nombra el secret, sin bloquear
  el merge. El secret sigue siendo necesario para que los checks revisen algo;
  lo que cambia es cómo se reporta que falta.

## [2.0.0] — 2026-07-28

### Cambios incompatibles

- **`PR_VALIDATOR_MODEL` pasa a ser obligatorio.** El validador ya no trae un
  modelo por defecto. Un repositorio que no lo define recibe un error de
  herramienta —advertencia visible, sin bloquear el merge— en vez de correr con
  un modelo que nadie eligió, cuyo costo y precisión nadie acordó.

  Para migrar desde `@v1`: define la variable `PR_VALIDATOR_MODEL` en el
  repositorio o la organización, y luego cambia la referencia a `@v2`. También
  sirve fijar `model` en `.pr-validator.json`, global o por check.

  `@v1` queda como estaba y sigue eligiendo modelo por su cuenta.

## [1.0.0] — 2026-07-28

Primera versión distribuible. El gate deja de vivir copiado dentro de cada
repositorio y pasa a consumirse como *reusable workflow*.

### Añadido

- Reusable workflow `pr-validation.yml` con inputs `checks`, `base`,
  `config-path`, `node-version` y `runs-on`.
- Checks `criteria`, `security` y `rules`, cada uno como su propio status check.
- Comentario **único** consolidado por PR, con tabla resumen y detalle plegable.
- Aviso visible cuando el diff o el corpus de reglas se truncan, indicando
  cuántos archivos quedaron fuera.
- Detección de PRs desde forks: los checks de IA se omiten en verde en vez de
  fallar por falta de secrets.
- Gate de neutralidad en CI y verificación de que los bundles correspondan a
  `src/`.
- 128 tests sobre la lógica determinista, con el gateway simulado.

### Notas de comportamiento

- El reporte **no** reproduce la descripción de la tarea. Los criterios
  cumplidos van en una línea; solo los incumplidos llevan explicación de qué
  falta.
- Un fallo de infraestructura (gateway, red, credenciales) nunca bloquea: se
  reporta como advertencia tras 3 reintentos.
- El presupuesto de reglas sube de 24.000 a 48.000 caracteres. En repositorios
  con corpus grandes esto significa que se evalúan reglas que antes se
  descartaban en silencio.

[1.0.0]: https://github.com/KeyCore-International/pr-validator/releases/tag/v1.0.0
