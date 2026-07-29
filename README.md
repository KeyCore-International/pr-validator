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
    uses: KeyCore-International/pr-validator/.github/workflows/pr-validation.yml@v3
    with:
      base: develop
    secrets:
      AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
      TASKS_API_EMAIL: ${{ secrets.TASKS_API_EMAIL }}
      TASKS_API_PASSWORD: ${{ secrets.TASKS_API_PASSWORD }}
```

Los secrets van **nombrados uno por uno**, no con `secrets: inherit`: inherit solo propaga cuando el workflow llamado vive en la misma organización, y este vive en otra.

Guía completa en [`docs/INSTALL.md`](docs/INSTALL.md). Detalle de cada check en [`docs/CHECKS.md`](docs/CHECKS.md).

## Configuración

### Inputs del workflow

| Input | Default | Descripción |
| --- | --- | --- |
| `checks` | *(vacío)* | Checks a ejecutar, separados por coma. Vacío = lo que diga `.pr-validator.json`, y si no lo dice, todos |
| `base` | `develop` | Rama base contra la que se calcula el diff |
| `config-path` | `.pr-validator.json` | Configuración por repositorio |
| `node-version` | `20` | Versión de Node del runner |

### `.pr-validator.json`

Opcional, en la raíz del repositorio consumidor. Permite ajustar el gate sin tocar el validador:

```json
{
  "model": "proveedor/modelo",
  "checks": ["criteria", "security", "rules", "quality", "tests"],
  "checksConfig": {
    "duplication": { "model": "proveedor/modelo-mas-capaz", "threshold": 0.7 },
    "quality": { "blocking": false }
  }
}
```

Precedencia, de menor a mayor: **defaults del validador < `config.json` del check < este archivo < inputs del workflow**.

Claves por check: `model`, `blocking`, `attempts`, `maxDiffChars`, `maxRulesChars`, `failOn`, y `threshold` / `maxCandidates` para `duplication`.

Si sólo vas a configurar checks y no a elegir cuáles corren, puedes usar `"checks"` como objeto en vez de `"checksConfig"`.

**Un archivo mal formado no bloquea nada**: se reporta como advertencia y el gate sigue con los valores por defecto. Una clave que el validador no reconoce se nombra en el comentario, para que un `blokcing: false` no pase por configurado durante meses.

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
| `quality` | Diseño: SOLID, complejidad, naming, código muerto, manejo de errores, números mágicos, idempotencia | Sí (severidad alta) |
| `duplication` | Métodos y funciones nuevos que replican lógica ya existente | Sí |
| `tests` | Símbolos públicos nuevos que ningún test menciona | Sí |

Un hallazgo pertenece a **un solo check**: `quality` revisa cómo está construido el código y no reporta vulnerabilidades, que son territorio exclusivo de `security`. Si el mismo problema saliera dos veces con dos redacciones, el desarrollador tendría que decidir cuál de los dos informes es el bueno.

Un check que falla por infraestructura (red, gateway, credenciales, cuota) **nunca bloquea**: se reporta como advertencia tras 3 reintentos.

Los checks que revisan código —`security`, `quality`, `duplication` y `tests`— **se omiten en verde cuando el diff no toca código**. Cuenta como código todo salvo texto plano documental y binarios: los YAML de workflow, los JSON de configuración, Terraform, Dockerfiles y SQL sí se revisan, porque ahí es donde viven los secretos embebidos.

## Referencia de tarea

Para el check `criteria`, el id de la tarea se busca en este orden:

1. **Nombre de rama** — `<id>-slug` bajo cualquier prefijo: `feature/2803-slug`, `fix/2803-slug`, o `2803-slug` a secas
2. **Título del PR** — `#2803`, `[2803]`, o `feat(scope): descripción (#2803)`
3. **Cuerpo del PR** — un bloque cercado con el lenguaje `criteria`

Dentro de la fuente que gana, el primer id es el que se evalúa; los demás ids que aparezcan en cualquier parte viajan como **contexto** para el modelo, y sus criterios nunca se exigen. Así un cuerpo que diga «corrección de la incidencia #3002 de la tarea #3001» se evalúa contra la incidencia, con la tarea original como trasfondo.

**La convención de nombres es un atajo, no una regla.** Nómbrala `<id>-slug` y el id se detecta sin que nadie escriba nada; si no, ponlo en el título. Un PR que no referencia ninguna tarea **no se bloquea**: `criteria` se omite en verde y el resto de checks sigue corriendo y sigue pudiendo frenar el merge. El gate frena por lo que el código tiene, nunca por cómo se llama la rama.

Cuando el diff no se corresponde con la tarea referenciada, el check lo dice con esas palabras en vez de listar criterios incumplidos: el problema es la referencia, no el código.

## Versionado

Tags `vX.Y.Z` inmutables y un tag móvil `vX` que siempre apunta al último release de ese major. Fijar `@v3` recibe correcciones y mejoras automáticamente; fijar `@v3.0.0` congela la versión.

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
