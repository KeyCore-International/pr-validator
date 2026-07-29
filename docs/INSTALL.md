# Instalación

Tiempo estimado: 10 minutos por repositorio, más una vez por organización para
los secrets.

## 1. Secrets y variables

Cárgalos **a nivel de organización** (Settings → Secrets and variables →
Actions → Organization). Así un repositorio nuevo los hereda sin configuración.

Si no tienes permisos de administrador de la organización, los mismos nombres a
nivel de repositorio (Settings → Secrets and variables → Actions) funcionan
igual: el workflow del paso 2 pasa los secrets del repositorio llamador, y
`vars` también se resuelve contra él. Lo único que pierdes es heredarlos en el
siguiente repositorio.

| Nombre | Tipo | Requerido | Valor |
| --- | --- | --- | --- |
| `AI_GATEWAY_API_KEY` | secret | Sí | Clave del gateway de IA |
| `TASKS_API_URL` | variable | Para `criteria` | URL base del gestor de tareas |
| `TASKS_API_EMAIL` | secret | Para `criteria` | Cuenta de servicio **de solo lectura** |
| `TASKS_API_PASSWORD` | secret | Para `criteria` | Contraseña de esa cuenta |
| `PR_VALIDATOR_MODEL` | variable | Sí | Modelo que ejecuta los checks |

El validador **no elige modelo por ti**. Sin `PR_VALIDATOR_MODEL` los checks
reportan error de herramienta —advertencia visible, sin bloquear el merge— en
vez de correr con un modelo que nadie acordó. Puede fijarse por repositorio, o
por check en `.pr-validator.json`.

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
    uses: KeyCore-International/pr-validator/.github/workflows/pr-validation.yml@v3
    with:
      base: develop
    secrets:
      AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
      TASKS_API_EMAIL: ${{ secrets.TASKS_API_EMAIL }}
      TASKS_API_PASSWORD: ${{ secrets.TASKS_API_PASSWORD }}
```

`permissions` es obligatorio: sin él el gate no puede publicar el comentario.

### Por qué los secrets van nombrados y no con `inherit`

`secrets: inherit` **solo propaga cuando el workflow llamado vive en la misma
organización o enterprise** que el que llama. Este validador vive en una
organización distinta a la de casi todos sus consumidores, así que con `inherit`
no llega ninguna credencial.

El fallo resultante es de los que cuestan una tarde: el gate se queja de un
secret ausente que sí existe y se ve en Settings, porque nunca cruzó el límite
entre organizaciones.

Nombrarlos uno por uno funciona en ambos casos. Omite los `TASKS_API_*` si no
usas el check `criteria`.

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
   - `quality`
   - `duplication`
   - `tests`

## 4. Cómo referenciar la tarea

**Es un atajo, no una regla.** Ninguna de estas formas es obligatoria y ninguna
ausencia bloquea un merge.

- **Lo más cómodo:** nombra la rama `<id>-slug`, bajo el prefijo que quieras —
  `feature/2803-filtro-fechas`, `fix/2803-error-texto`, o `2803-filtro` a secas.
  El id se detecta sin que nadie escriba nada más.
- **Si la rama ya se llama de otra forma:** pon el id en el título del PR, como
  `#2803`, `[2803]` o `feat(scope): descripción (#2803)`.
- **Si la tarea no está en el gestor:** un bloque cercado ` ```criteria ` en el
  cuerpo del PR sirve de contrato.

Cuando el PR menciona varias tareas, se evalúa contra la primera de la fuente de
mayor precedencia y las demás entran como contexto. Un cuerpo que diga
«corrección de la incidencia #3002 de la tarea #3001» se juzga contra la
incidencia, no contra la tarea de la que salió.

Un PR sin ninguna referencia **no falla**: `criteria` se omite en verde y
`security`, `rules` y los demás siguen corriendo y siguen pudiendo frenar el
merge.

## 5. Verificar la instalación

Abre un PR de prueba desde una rama sin id, por ejemplo `chore/pr-validation`.
Deberías ver:

- Los checks en la lista del PR.
- Un único comentario con la tabla resumen.
- `criteria` omitido en verde, porque no hay tarea que validar.

Si `criteria` aparece como error de herramienta, revisa `TASKS_API_URL` y las
credenciales. Si todos aparecen como error, falta `AI_GATEWAY_API_KEY` o
`PR_VALIDATOR_MODEL`: el propio mensaje dice cuál.

## Actualizaciones

Fijar `@v3` implica recibir cada corrección y mejora automáticamente en el
siguiente PR, sin tocar el repositorio. Para congelar una versión concreta,
fija `@v3.0.0`.

Los majors anteriores siguen existiendo y no cambian. Lo que hay que revisar
antes de subir la referencia:

- **De `@v1` a `@v2`**: define `PR_VALIDATOR_MODEL`; `v1` elegía un modelo por su
  cuenta y `v2` no.
- **De `@v2` a `@v3`**: el gate deja de bloquear por la nomenclatura de la rama y
  empieza a correr `quality`, `duplication` y `tests`. Si tenías marcados los
  checks como *required* en la protección de rama, añade los tres nuevos después
  de su primera corrida.
