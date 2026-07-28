# PR Validator

Gate de validación de pull requests como *reusable workflow* de GitHub Actions.

Cada PR se revisa por dimensiones independientes —criterios de aceptación de la tarea, seguridad, reglas del propio proyecto, calidad, duplicación de código y cobertura de tests— y el resultado se publica como **un único comentario** con veredicto por dimensión y evidencia `path:line`.

Cada dimensión es su propio *status check*, así que puedes exigir las que quieras en la protección de rama y dejar el resto como informativas.

## Instalación

En el repositorio que quieras proteger, crea `.github/workflows/pr-validation.yml`:

```yaml
name: PR Validation
on:
  pull_request:
    branches: [develop]
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: pr-validation-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  build-test:
    name: Build & test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ...los pasos de build y test propios de tu stack

  validate:
    uses: KeyCore-International/pr-validator/.github/workflows/pr-validation.yml@v2
    with:
      checks: 'criteria,security,rules'
      base: develop
    secrets: inherit
```

Guía completa en [`docs/INSTALL.md`](docs/INSTALL.md). Detalle de cada check en [`docs/CHECKS.md`](docs/CHECKS.md).

## Configuración

### Inputs del workflow

| Input | Default | Descripción |
| --- | --- | --- |
| `checks` | `criteria,security,rules` | Checks a ejecutar, separados por coma |
| `base` | `develop` | Rama base contra la que se calcula el diff |
| `config-path` | `.pr-validator.json` | Configuración por repositorio |
| `node-version` | `20` | Versión de Node del runner |

### Secrets y variables

Se definen en el repositorio consumidor, o mejor a nivel de organización. **Este repositorio no contiene ningún valor secreto**; todo se lee del entorno que inyecta el consumidor.

| Nombre | Tipo | Requerido | Uso |
| --- | --- | --- | --- |
| `AI_GATEWAY_API_KEY` | secret | Sí | Inferencia de todos los checks |
| `TASKS_API_URL` | variable | Solo para `criteria` | URL base del gestor de tareas |
| `TASKS_API_EMAIL` | secret | Solo para `criteria` | Cuenta de servicio de solo lectura |
| `TASKS_API_PASSWORD` | secret | Solo para `criteria` | Contraseña de esa cuenta |
| `PR_VALIDATOR_MODEL` | variable | Sí | Modelo que ejecuta los checks |

## Checks disponibles

| Check | Qué evalúa | Bloquea por defecto |
| --- | --- | --- |
| `criteria` | Criterios de aceptación de la tarea referenciada por el PR | Sí |
| `security` | Vulnerabilidades introducidas por el diff | Sí (severidad alta) |
| `rules` | Convenciones que el propio repositorio documentó | Sí |
| `quality` | Principios universales: SOLID, complejidad, naming, código muerto | No |
| `duplication` | Símbolos nuevos que replican lógica ya existente | No |
| `tests` | Símbolos públicos nuevos sin cobertura de tests | No |

Un check que falla por infraestructura (red, gateway, credenciales) **nunca bloquea**: se reporta como advertencia tras 3 reintentos.

## Referencia de tarea

Para el check `criteria`, el id de la tarea se busca en este orden:

1. **Título del PR** — `#2803`, `[2803]`, o `feat(scope): descripción (#2803)`
2. **Nombre de rama** — `feature/2803-slug`
3. **Cuerpo del PR** — un bloque cercado con el lenguaje `criteria`

Las ramas con prefijo `chore/`, `hotfix/`, `release/`, `dependabot/` o `renovate/` quedan exentas y el check pasa en verde.

## Versionado

Tags `vX.Y.Z` inmutables y un tag móvil `vX` que siempre apunta al último release de ese major. Fijar `@v2` recibe correcciones y mejoras automáticamente; fijar `@v2.0.0` congela la versión.

Un cambio incompatible siempre implica un major nuevo.

## Desarrollo

```bash
npm install
npm test          # vitest sobre la lógica determinista
npm run build     # empaqueta src/ en actions/*/dist/
npm run build:check   # verifica que los bundles correspondan a src/
```

Los bundles de `actions/*/dist/` se commitean a propósito: GitHub ejecuta el código de la action directamente desde el repositorio. CI falla si un bundle no corresponde a su fuente.

## Licencia

MIT — ver [LICENSE](LICENSE).
