# AGENTS.md

Guía para agentes de IA que trabajen en este repositorio.

## Qué es esto

Un gate de validación de pull requests distribuido como **reusable workflow** de
GitHub Actions. Otros repositorios, de otras organizaciones, lo consumen con
`uses: KeyCore-International/pr-validator/.github/workflows/pr-validation.yml@v1`.

Eso condiciona todo lo demás: **un cambio aquí llega al CI de equipos ajenos en
cuanto se mueve el tag mayor.** No es una librería que alguien decide actualizar;
es un despliegue.

## Comandos

```bash
npm install
npm test                  # vitest sobre la lógica determinista
npm run build             # empaqueta src/ en actions/*/dist/
npm run build:check       # verifica que los bundles correspondan a src/
npm run check:neutrality  # verifica que no haya nombres de cliente ni rutas locales
```

No hay linter configurado. Si añades uno, que sea en su propio cambio.

## Las cuatro reglas que más duelen si se ignoran

### 1. Editar `src/` obliga a reconstruir

GitHub ejecuta el código de una action **directamente desde el repositorio**, sin
paso de instalación. Por eso `actions/*/dist/index.mjs` está commiteado a
propósito.

Si editas `src/` y no corres `npm run build`, el repositorio dice una cosa y
ejecuta otra. `npm run build:check` es un gate de CI justo por eso, y en un fallo
imprime dónde divergen.

### 2. Este repositorio es público, y el código vino de uno privado

Nunca introduzcas nombres de cliente, dominios internos, correos ni rutas
absolutas de una máquina. El gestor de tareas se referencia **solo** por su
configuración neutral `TASKS_API_*`.

`scripts/neutrality.mjs` lo verifica en cada PR. **No amplíes su lista de
exclusiones.** Los bundles generados están dentro del alcance del escaneo a
propósito: una versión anterior del build incrustaba la ruta absoluta del autor
en el bundle, y no se detectó precisamente porque la salida generada estaba
excluida por "generada".

### 3. La firma pública es un contrato

Los `inputs` y `secrets` de `.github/workflows/pr-validation.yml`, y los `inputs`
de `actions/*/action.yml`, son la superficie que otros repositorios ya usan.

Un cambio incompatible exige un **major nuevo**. El tag `v1` jamás debe empezar a
comportarse distinto para quien ya lo fijó.

### 4. Un fallo de infraestructura nunca bloquea

Gateway caído, red, credenciales ausentes: eso es `tool-error`, se reporta como
advertencia y deja pasar el merge. Solo un problema **del código** bloquea.

Bloquear por un tercero caído deja al equipo entero rehén y enseña a ignorar el
gate.

## Arquitectura

```
.github/workflows/pr-validation.yml   EL PRODUCTO — reusable (workflow_call)
actions/run-check/                    composite action: corre 1 check
actions/report/                       composite action: publica el comentario
src/
  run-check.mjs                       orquesta un check -> verdict.json
  report.mjs                          N verdicts -> 1 comentario
  gateway.mjs                         llamada al modelo + reintentos + parseo
  context/                            diff, task-ref, tasks-api, rules, config
  checks/<nombre>/                    prompt.md + config.json + render.mjs
  report/                             verdict.mjs (esquema), comment.mjs (render)
  entries/                            entrypoints de los bundles
scripts/                              build.mjs, neutrality.mjs
test/                                 vitest + fixtures
```

Flujo de una corrida:

```
setup   -> resuelve la lista de checks a matriz JSON
checks  -> matriz, un job por check -> verdict.json como artifact
report  -> needs: [checks], if: always() -> un solo comentario
```

### Por qué el gate va después de subir el artifact

En el job `checks`, `upload-artifact` va **antes** del paso que pone el job en
rojo. Si la action saliera con código distinto de 0, el job moriría antes de
subir su veredicto y el comentario consolidado perdería justo el check que falló.

Por eso `run-check` **siempre sale 0** y expone `blocking-failure` como output.

### Por qué composite y no `node20`

Solo una composite action puede declarar su propio `env:`. Así la action lee el
contexto del PR por su cuenta y el workflow del consumidor no tiene que
cablearlo.

## Añadir un check

Un check es una carpeta autocontenida. El runner no se toca.

1. Crea `src/checks/<nombre>/` con:
   - `prompt.md` — el system prompt, como prosa editable
   - `config.json` — `blocking`, `failOn`, presupuestos, modelo
   - `render.mjs` — exporta `meta`, `config`, `buildPrompt`, `accept`, `render`
2. Añade el import en `src/checks/registry.mjs` (imports estáticos: dentro del
   bundle no existe `src/checks/` que escanear).
3. Añade el nombre a `CHECK_ORDER`.
4. Tests con el gateway simulado, y `npm run build`.

`render()` devuelve `rows` y `details` por separado, y **no es cosmético**:
`rows` es la tabla escaneable, `details` es prosa que solo se emite para lo que
hay que corregir. La separación impide que un check vuelque el texto íntegro de
una tarea de cliente en un comentario público.

Un check nuevo arranca **no bloqueante** hasta tener datos de precisión.

## Convenciones

- **Código, identificadores y prompts en inglés.** Reportes y comentarios de PR
  **en español**.
- Commits en inglés, formato conventional commits.
- **Prohibida la atribución a IA** en commits y PRs: nada de `Generated with`,
  `Co-Authored-By: Claude` ni similares.
- Los prompts viven en `prompt.md`, no como literales en JS. Se inlinean en el
  bundle mediante el plugin `?raw` de `scripts/build.mjs`, que resuelve rutas
  **relativas al repositorio** — nunca absolutas.
- Finales de línea LF, forzados por `.gitattributes`. `build:check` compara byte
  a byte; un CRLF haría fallar CI sin que nada esté roto.

## Trampas conocidas

- **`vars` en el workflow reusable** se resuelve contra el repositorio
  *llamador*, no contra este.
- **PRs desde forks** no reciben secrets. Se detectan y los checks de IA se
  omiten en verde. **Nunca uses `pull_request_target`** para esquivarlo: ejecuta
  código no confiable con acceso a secrets.
- **La matriz de checks** se construye en un job `setup` con Node, no con una
  expresión inline. La versión inline exigía escapes en tres capas.
- **Todo truncado se declara.** Diff y corpus de reglas tienen presupuesto; si se
  recorta, el comentario dice cuánto y cuántos archivos quedaron fuera. Truncar
  en silencio fue el fallo más grave de la generación anterior de esta
  herramienta.

## Qué NO hacer

- No commitear sin que lo pidan explícitamente.
- No tocar `actions/*/dist/` a mano. Es salida de build.
- No añadir dependencias a la ruta de ejecución sin necesidad real: cada una
  entra en un bundle que corre en el CI de otros equipos.
- No mover un tag mayor a mano. Lo hace `release.yml` tras pasar tests,
  `build:check`, neutralidad y coincidencia de versión.
