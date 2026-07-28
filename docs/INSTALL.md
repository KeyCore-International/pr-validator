# Instalación

Tiempo estimado: 10 minutos por repositorio, más una vez por organización para
los secrets.

## 1. Secrets y variables

Cárgalos **a nivel de organización** (Settings → Secrets and variables →
Actions → Organization). Así un repositorio nuevo los hereda sin configuración.

| Nombre | Tipo | Requerido | Valor |
| --- | --- | --- | --- |
| `AI_GATEWAY_API_KEY` | secret | Sí | Clave del gateway de IA |
| `TASKS_API_URL` | variable | Para `criteria` | URL base del gestor de tareas |
| `TASKS_API_EMAIL` | secret | Para `criteria` | Cuenta de servicio **de solo lectura** |
| `TASKS_API_PASSWORD` | secret | Para `criteria` | Contraseña de esa cuenta |
| `PR_VALIDATOR_MODEL` | variable | No | Modelo por defecto |

La cuenta del gestor de tareas debe ser una cuenta de servicio dedicada y sin
permisos de escritura. Estas credenciales viven en repositorios de varias
organizaciones; una cuenta personal amplía el daño de una fuga sin necesidad.

## 2. Workflow del repositorio

Crea `.github/workflows/pr-validation.yml`. Lo único que cambias es el job
`build-test`, que es específico de tu stack.

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
      # ...pasos propios de tu stack

  validate:
    uses: KeyCore-International/pr-validator/.github/workflows/pr-validation.yml@v1
    with:
      checks: 'criteria,security,rules'
      base: develop
    secrets: inherit
```

`permissions` y `secrets: inherit` son obligatorios: sin el primero el gate no
puede publicar el comentario, y sin el segundo no recibe las credenciales.

### Ejemplos de `build-test`

**.NET**

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '9.0.x' }
      - run: dotnet restore MiSolucion.sln
      - run: dotnet build MiSolucion.sln -c Release --no-restore
      - run: dotnet test MiSolucion.sln -c Release --no-build
```

**Node con pnpm**

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm build
```

Usa los nombres reales de tus scripts y de tu solución. Un job `build-test` que
no corre lo que el repositorio realmente corre da una falsa sensación de
cobertura.

## 3. Protección de rama

En Settings → Branches (o Rules), sobre la rama base:

1. Exigir pull request con al menos una aprobación.
2. Bloquear force-push.
3. **Después de la primera corrida** —los checks no aparecen en la lista hasta
   que han corrido al menos una vez— marcar como *required*:
   - `Build & test`
   - `criteria`
   - `security`
   - `rules`

## 4. Convención de ramas

- Trabajo de tarea: `feature/<id>-<slug>`, por ejemplo `feature/2803-filtro-fechas`.
- Exentas, sin tarea asociada: `chore/`, `hotfix/`, `release/`, `dependabot/`,
  `renovate/`, y las ramas largas `master`, `main`, `qa`, `develop`.
- Cualquier otro nombre sin id de tarea falla el check `criteria`, con un
  comentario que explica la convención.

## 5. Verificar la instalación

Abre un PR de prueba desde una rama `chore/`. Deberías ver:

- Los tres checks en la lista del PR.
- Un único comentario con la tabla resumen.
- `criteria` omitido en verde, por ser una rama exenta.

Si `criteria` aparece como error de herramienta, revisa `TASKS_API_URL` y las
credenciales. Si todos aparecen como error, falta `AI_GATEWAY_API_KEY`.

## Actualizaciones

Fijar `@v1` implica recibir cada corrección y mejora automáticamente en el
siguiente PR, sin tocar el repositorio. Para congelar una versión concreta,
fija `@v1.0.0`.
