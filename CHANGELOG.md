# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/): los tags `vX.Y.Z` son inmutables
y el tag `vX` se mueve al último release de ese major.

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
