# Modo local

`dist/local/pr-local.mjs` es el motor del validador empaquetado como una CLI que
corre en la máquina del desarrollador, antes del push o del merge. Hace todo lo
que se puede decidir sin un modelo y prepara, byte a byte, lo que la CI le
enviaría a uno.

- **Sin dependencias.** Un solo archivo ESM para Node ≥20, con solo módulos
  nativos. El build falla si el bundle alcanza el SDK de IA, el gateway o el
  cliente del gestor de tareas: el modo local nunca llama a un modelo ni a la red.
- **Mismo motor que la CI.** Los prompts que escribe son los de la CI, y los
  veredictos que escribe tienen su misma forma. Una corrida local y una de la CI
  sobre el mismo commit no pueden discrepar en lo determinista.
- **Determinista.** `facts.json` se escribe con claves ordenadas y sin marcas de
  tiempo: dos corridas sobre el mismo commit dan los mismos bytes, así que su
  hash sirve para auditar después de qué se calculó un veredicto.
- **CLI y módulo a la vez.** Ejecutado, es la CLI; importado, expone la misma
  API (ver [Como biblioteca](#como-biblioteca)) sin arrancar la CLI.

## Uso

```bash
node pr-local.mjs <comando> [opciones]
node pr-local.mjs <comando> --help
node pr-local.mjs --version
```

Opciones comunes: `--repo <dir>` (por defecto, el directorio actual) y
`--config <ruta>` (por defecto, `.pr-validator.json`).

| Comando     | Qué hace                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `facts`     | Hechos de la rama: diff, clasificación, disparadores, escalón, historial, duplicación, homónimos, cobertura |
| `prompts`   | El `system` y el `user` que cada check enviaría en la CI, o el veredicto al que llega sin modelo            |
| `render`    | Convierte la respuesta de un revisor en el veredicto que escribiría la CI                                   |
| `config`    | La configuración resuelta, con el bloque `local` de la rama y, con `--base`, el de la base                  |
| `inventory` | Símbolos exportados y sus firmas bajo los directorios indicados, sin cuerpos                                |
| `rules`     | El corpus de reglas acotado a los archivos tocados, más packs de reglas extra reportados aparte             |

### Códigos de salida

| Código | Significado                                               |
| -----: | --------------------------------------------------------- |
|      0 | OK                                                        |
|      1 | Uso incorrecto (o un error interno, con la traza)         |
|      2 | Error de git (por ejemplo, una ref que no existe)         |
|      4 | El árbol rastreado tiene cambios sin commitear            |
|      5 | La base (o `--since`) no es ancestro de HEAD              |
|      6 | HEAD se movió durante la corrida, o no es `--expect-head` |

## `facts`

```bash
node pr-local.mjs facts --out <dir> [--base origin/develop] [--since <ref>] \
  [--triggers <archivo>]… [--attribution <archivo>] [--fix] [--branch <rama>] [--quick | --full] \
  [--s-max 400] [--m-max 1500] [--expect-head <sha>] [--allow-behind]
```

Escribe en `<dir>`:

- `facts.json`: los hechos, con claves ordenadas;
- `facts.md`: un resumen en español;
- `diff.patch`: `merge-base(base, HEAD)..HEAD`;
- `diff-since.patch`, solo con `--since`.

**Precondiciones.** Se niega a correr con el árbol rastreado sucio (código 4): el
índice de duplicación y el cruce de cobertura leen archivos del disco, y unos
hechos que describen un commit mientras leen ediciones sin commitear no
describen ninguno. Los archivos sin rastrear no cuentan. Describe siempre HEAD;
para otro commit, haz checkout primero.

**`--since` no achica el escalón.** Los disparadores y el escalón se calculan
siempre sobre `merge-base..HEAD`. `--since` solo añade la descripción del delta
(`since` en el JSON y `diff-since.patch`): una re-ejecución no puede sacar una
migración de la vista empezando después del commit que la añadió.

### Lo que contiene `facts.json`

| Clave                                                                        | Contenido                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`, `head`, `mergeBase`                                                  | Las refs y SHAs de la corrida                                                                                                                                                                                                                                                     |
| `preconditions`                                                              | Árbol limpio, si la base es ancestro, si se usó `--allow-behind`                                                                                                                                                                                                                  |
| `files`, `counts`, `prodLines`                                               | Archivos clasificados y líneas de producción (sin tests, generados, docs, locales ni estilos)                                                                                                                                                                                     |
| `triggers`                                                                   | `ids` y los `hits` de cada disparador, con ruta y línea                                                                                                                                                                                                                           |
| `tier`                                                                       | Escalón calculado, forzado o rechazado, con sus razones                                                                                                                                                                                                                           |
| `commits`, `foreignMerges`, `attribution`                                    | Historial: merges de otras ramas y atribución a herramientas en los mensajes                                                                                                                                                                                                      |
| `duplication.findings`                                                       | Candidatos a duplicado: símbolo tocado, candidatos, puntuación y señales (`name`, `signature`, `body`, `vocabulary`)                                                                                                                                                              |
| `duplication.homonyms`                                                       | Mismo nombre, distinto comportamiento: dos `formatDate` que formatean distinto                                                                                                                                                                                                    |
| `duplication.truncation`, `suppressed`, `headIgnores`, `invalidSuppressions` | Lo que los topes dejaron fuera y las supresiones en línea: aplicadas, agregadas por la rama (no aplicadas) o sin motivo                                                                                                                                                           |
| `coverage.untestedLogic`                                                     | Funciones exportadas **con lógica** que ninguna prueba cubre, con `endLine`, `change` y las razones (`branches`, `loop`, `date`…)                                                                                                                                                 |
| `coverage.exempt`                                                            | Lo que no exige prueba propia (DTOs, getters, mapeos simples, delegación), con el motivo                                                                                                                                                                                          |
| `coverage.suite`                                                             | `present` si el repositorio tiene al menos un archivo de prueba, `none` si no tiene ninguno                                                                                                                                                                                       |
| `coverage.logicTouched`, `logicTouchedCount`                                 | Funciones **con lógica**, de cualquier alcance, que el diff agrega o cambia (por span), solo en archivos de producción, calculadas haya o no suite: `change` (`added`/`modified`), `endLine`, razones y `suite` del lenguaje de cada una (`present`/`none`). Tope de 200 listadas |
| `configNotes`                                                                | Avisos al leer `.pr-validator.json`                                                                                                                                                                                                                                               |

`coverage.orphans` es la misma lista que `coverage.untestedLogic`, con su nombre
de siempre.

**Sin suite.** `untestedLogic` solo se llena cuando el repositorio tiene pruebas:
sin ninguna no hay contra qué cruzar. `logicTouched` responde la pregunta previa,
¿el cambio toca lógica?, y la responde siempre. El `suite` de cada entrada se mira
por lenguaje (C#, TS/JS/Vue, PHP): en un repositorio con una API probada y un
frontend sin pruebas, la lógica del frontend sale con `suite: none` aunque
`coverage.suite` sea `present`. Es un hecho, no un veredicto: qué hacer con él lo
decide quien consume `facts.json`.

**Duplicación, solo código.** Se comparan funciones y métodos de **todos** los
alcances —privados, métodos de clase, funciones internas de un composable o de
`<script setup>`— que el diff tocó, por span: una función nueva cuenta, y también
una existente cuyo cuerpo se reescribió. La duplicación de markup (plantillas)
no está aquí: necesita un escáner de markup, no un comparador de funciones. Los
hechos nunca llevan el código fuente: solo nombre, ruta, línea, span, alcance y
contenedor de cada símbolo.

**`duplication.allow` se lee de la base.** Un par permitido silencia un hallazgo,
así que afloja el gate: se toma de `.pr-validator.json` tal como está en la rama
base, nunca del de la rama revisada. `duplication.allowPairs` dice cuántos se
aplicaron.

**Supresión en línea.** `// pr-validator-ignore duplication: <motivo>` sobre la
función que el diff toca la saca de la comparación, siempre que la rama base ya
tuviera ese comentario; queda en `suppressed`. Uno que agrega la propia rama no se
aplica, como `allow`: el símbolo se compara igual y el comentario queda en
`headIgnores`. Sin motivo no vale y queda en `invalidSuppressions`.

### Disparadores

`--triggers <archivo>` (repetible) añade patrones. El formato:

```json
{
  "triggers": {
    "MIG": { "paths": ["**/Migrations/*.cs"], "added": ["/\\bmigrationBuilder\\./"] },
    "WRITE": { "added": ["/\\[Http(Post|Put|Patch|Delete)\\b/"] }
  }
}
```

Por disparador: `paths`, `newPaths`, `added`, `addedIn`, `commits`, `branches` y `scope`.
Un elemento de `added` puede ser también `{ "pattern": "/…/", "in": ["glob", …] }`: ese
patrón solo lee los archivos que nombra su propio `in`, y `addedIn` sigue acotando
solo los patrones escritos como texto. Sirve para pesar lo que cambió y no dónde:
«una línea de token, guard o permiso dentro de `auth/`» en lugar de «cualquier
archivo de `auth/`».
`branches` son expresiones sobre el nombre de la rama revisada. Un archivo que
casa con varios globs de `paths` (o de `newPaths`) del mismo disparador es un solo
hit: dos globs que se solapan no cuentan dos veces el mismo archivo.
Las expresiones regulares se escriben `"/cuerpo/flags"`. También se acepta el
mapa de ids sin envoltorio, o una lista `[{ "id": …, … }]`. El bloque
`local.triggers` de `.pr-validator.json` se suma igual. Los patrones solo se
**añaden**: un repositorio no puede quitar uno.

`FIX` viene incluido y nunca sube el escalón. Marca una corrección de incidente:
una rama `fix/…` o `hotfix/…`, o la opción `--fix` (una incidencia). El asunto de un
commit no lo dispara: `fix(…):` es también como una rama de funcionalidad registra
las correcciones de su propia revisión. La rama sale del repositorio: `--branch
<rama>` si se pasa; si no, la rama actual; con el checkout desacoplado (un worktree
sobre un SHA), la única rama, local o si no remota, cuya ref apunta a HEAD, sin
contar la base. Con ninguna o con varias queda vacía y hay que pasar `--branch`.
Queda en `branch` de `facts.json`, y `branchSource` dice de dónde salió (`arg`,
`checkout`, `ref` o `null`). Si solo disparó `FIX`, la razón
del escalón lo nombra en vez de decir «no triggers».

### Escalones

| Escalón | Predicado (gana el primero que se cumpla)                  |
| ------- | ---------------------------------------------------------- |
| XS      | 0 líneas de producción                                     |
| S       | ≤ `--s-max` líneas, sin AUTH, MIG, WRITE ni SEED           |
| M       | ≤ `--m-max` líneas, o 2 disparadores, o AUTH, MIG o WRITE  |
| L       | > `--m-max` líneas, ≥3 disparadores, SEED, o MIG con WRITE |

`--quick` fuerza S y se rechaza si hay AUTH, MIG, WRITE o SEED. `--full` fuerza
L. Lo forzado queda registrado en `tier`.

## `prompts` y `render`

```bash
node pr-local.mjs prompts --out <dir> [--checks a,b] [--head-ref <rama>] \
  [--title <texto>] [--body-file <archivo>] [--task-file <archivo>] [--model <id>]
node pr-local.mjs render --out <dir> --check <nombre> [--in respuesta.json] [--model <id>]
```

`prompts` escribe `prompts/<check>.system.md`, `.user.md` y `.ctx.json` por cada
check que llamaría a un modelo, o `<check>.skip.json` con el veredicto al que se
llega sin él, más `prompts/index.json`. El contenido es el de la CI salvo los
UUID aleatorios que delimitan los bloques no confiables.

**Repositorio.** `repo` en `facts.json`, la línea «Repositorio» de `facts.md` y el
`Repo:` de los prompts nombran el repositorio, no la carpeta: el último segmento
de la URL de `origin`, si no la carpeta del clon principal (la que tiene el `.git`
compartido), si no la del checkout. Dos worktrees del mismo commit escriben los
mismos bytes.

**Presupuesto del diff.** Antes de recortar a `maxDiffChars` se apartan los
archivos que nadie escribe a mano: lockfiles, snapshots y generados (`*.Designer.cs`,
`*ModelSnapshot.cs`, `*.g.cs`, `*.generated.*`, `dist/`…, la misma tabla de
categorías que cuenta las líneas de producción). El stat los sigue listando y el
diff termina con una línea que los nombra. La duplicación y la cobertura del prompt
se calculan sobre el diff revisable completo, sin recortar, igual que en la CI: lo
que cupo en el prompt ya no decide qué símbolos existen, y el skip de duplicación
no contradice los candidatos de `facts`.

El recorte va por archivos enteros y por orden de valor: primero producción,
luego estilos y locales, luego pruebas, y la documentación, las carpetas de
herramientas y los assets solo con lo que sobra. Un archivo que no cabe se salta
y se sigue con los demás; lo que entra conserva el orden de git. Solo si no cabe
ninguno entero se corta el primero de la cola, en un límite de hunk. El diff cierra
con una línea que nombra **cada** archivo que quedó fuera. El stat lleva las rutas
completas: la forma abreviada (`.../Services/X.cs`) dejaba fuera de alcance reglas
con `paths:` que sí aplicaban.

**Presupuesto de reglas.** Se sirve primero el `AGENTS.md` más cercano a cada
archivo tocado (el de la raíz incluido; si no hay ninguno por encima, el
`CLAUDE.md` más cercano), luego las reglas cuyos `paths:` nombran archivos del
cambio (las de globs concretos antes que las de `**/*.ext`, y entre ellas las que
cubren más archivos), y al final las que no declaran alcance. El texto conserva el
orden de descubrimiento.

**Prompt parcial.** Cuando el prompt no muestra todo lo que revisa, `<check>.ctx.json`
lleva `partial: true`, `partialReasons` (`diff-truncated`, `rules-truncated`,
`duplication-index-truncated`, `duplication-comparison-truncated`) y `diff` con
`shownChars`, `totalChars`, `totalFiles`, `includedFiles`, `omittedFiles`,
`omittedPaths` (cada archivo que quedó fuera), `partialPath` (el que se cortó, o
`null`) y `exemptFiles`. `prompts/index.json` repite `partial` y `partialReasons` por check y
lleva un `partial` global. Quien orquesta la revisión lee el resto de la rama de
`diff.patch` antes de juzgar un prompt parcial.

`render` lee `prompts/<check>.ctx.json` y la respuesta del revisor (JSON plano o
un único bloque cercado), y escribe `verdicts/<check>.json` con la forma de la
CI. Un check resuelto sin modelo no necesita `--in`: se copia su veredicto.

## `config`, `inventory` y `rules`

- `config [--base <ref>] [--out <dir>]`: la configuración de la rama, su bloque
  `local`, la configuración resuelta de cada check y, con `--base`, la copia de la
  base. Qué claves del bloque `local` se aceptan desde la rama es decisión de quien
  la consume; por eso recibe las dos copias.
- `inventory --dirs <a,b> [--out <dir>]`: símbolos exportados con firma, sin
  cuerpos, para buscar antes de crear.
- `rules [--extra-dir <dir>]… [--touched a,b | --base <ref>] [--out <dir>]`: las
  reglas del repositorio acotadas por `paths:`/`globs:` a los archivos tocados, y
  cada directorio extra reportado aparte.

Las reglas se leen de `.claude/rules`, `.agents/rules` (en ese orden, sin repetir
un archivo que sea el mismo por junction o enlace), los `CLAUDE.md`/`AGENTS.md`
más cercanos a cada archivo tocado, y los de la raíz. El alcance de una regla se
declara con `paths`, `globs`, `appliesTo` o `files`, como lista entre comillas
separada por comas, lista YAML en línea o lista YAML en bloque.

## El bloque `local` de `.pr-validator.json`

La CI acepta la clave `local` y no mira su contenido: es configuración para las
herramientas del modo local. `config` la devuelve tal cual.

`checks.duplication.allow` y `checks.duplication.reference` son claves propias de
`duplication` (en cualquier otro check se reportan como desconocidas).

## Como biblioteca

```js
import {
  nameSimilarity, signatureSimilarity, bodySimilarity, buildSymbolIndex,
  matchesAny, declaredScope, computeMetrics, logicProfile, isLogicBearing,
  classifyRange, computeTier, evaluateTriggers, stableStringify, ENGINE_VERSION,
} from './pr-local.mjs';
```

Importarlo no arranca la CLI.

## Build

```bash
npm run build              # todos los bundles, incluido dist/local/pr-local.mjs
npm run build -- --only local
npm run build:check        # falla si algún bundle commiteado no coincide con src/
```

El target `local` lleva el plugin `forbid`: si la resolución llega a `ai`,
`@ai-sdk/*`, `gateway.mjs` o `tasks-api.mjs`, el build falla. Una prueba de vitest
comprueba además que el bundle no contiene `from "ai"`.
