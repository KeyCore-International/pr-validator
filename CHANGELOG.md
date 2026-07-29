# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/): los tags `vX.Y.Z` son inmutables
y el tag `vX` se mueve al último release de ese major.

## [3.4.0] — 2026-07-28

### Añadido

- **`rules` lee todas las convenciones del repositorio, no sólo una carpeta.**
  Además de `.claude/rules/**`: `.cursor/rules/**`, `.cursorrules`,
  `.github/copilot-instructions.md`, `CLAUDE.md`, `AGENTS.md` y
  `CONTRIBUTING.md`.

  El orden es la política de presupuesto: una carpeta que alguien creó *para
  guardar reglas* dice más sobre las convenciones que un archivo raíz que además
  explica cómo correr los tests, así que cuando el presupuesto se agota lo que
  se cae es la fuente más vaga.

- **Prefiltro por relevancia.** Una regla que declara su alcance en frontmatter
  —`globs: src/**/*.vue`— se omite cuando el PR no toca ningún archivo que
  encaje, y se omite **antes** de aplicar el presupuesto: una regla que no
  aplica no debería haberle quitado sitio a una que sí.

  Sólo se respeta el alcance **declarado**. No se adivina: descartar
  `frontend.md` porque el diff no trae `.vue` acabaría descartando, algún día,
  justo la regla que el PR incumple, y un gate que se pierde lo que le pidieron
  cazar es peor que uno que lee de más.

- **El comentario declara las fuentes cargadas y las omitidas con su motivo**, y
  «fuera de alcance» se distingue de «presupuesto» porque no son la misma
  noticia.

- **`.pr-validator.json` funciona.** El input `config-path` estaba declarado
  desde `v1.0.0`, `resolveConfig` aceptaba `repoConfig` desde entonces, y no
  había quien cargara el archivo: nada de lo que un repositorio escribiera ahí
  tenía efecto.

  Ahora un repositorio puede fijar modelo, presupuestos, `blocking`, `failOn` y
  el umbral de `duplication`, global o por check, con la precedencia
  documentada: `defaults < config.json del check < archivo del repo < inputs del
  workflow`.

  Un archivo mal formado **no bloquea**: se reporta como advertencia y el gate
  sigue con los valores por defecto. Y una clave que el validador no reconoce se
  nombra en el comentario, para que un `blokcing: false` no pase por configurado
  durante meses.

- **La lista de checks se valida contra el registro**, en un job propio y antes
  de que la matriz se abra. Un nombre mal escrito se nombra junto a los
  disponibles y se descarta; si ninguno es válido se ejecutan todos, porque
  ejecutar nada dejaría el PR sin revisar con todos los checks en verde — un
  gate que no protege nada y no dice nada.

  La lista válida sale de `src/checks/registry.mjs` a través de la nueva action
  `resolve-checks`, y no de una cadena duplicada en YAML que se desincroniza el
  primer día que alguien añade un check.

### Cambiado

- El input `checks` del workflow pasa a tener **default vacío**, que significa
  «lo que diga `.pr-validator.json`, y si no lo dice, todos los checks». Antes
  el default era la lista literal, así que el archivo del repositorio nunca
  podía ganarle. Un valor vacío antes abortaba la corrida; ahora es la forma de
  no opinar.

## [3.3.0] — 2026-07-28

### Añadido

- **Check `duplication`.** Responde si algo que el PR introduce replica lógica
  que ya vive en el repositorio — el único check que necesita mirar más allá del
  diff, porque para decir «esto ya existe» hay que saber qué existe.

  Dos pasadas. La determinista indexa los símbolos públicos de todo el
  repositorio y puntúa cada método o función nuevo contra ese índice con tres
  señales: esqueleto del cuerpo (0,5), nombre tokenizado (0,3) y firma (0,2).
  Sólo los pares que superan el umbral —0,55 por defecto— llegan al modelo, con
  un tope de cinco candidatos por símbolo. Si nada lo supera, que es lo
  habitual, el check se omite sin gastar llamada.

  Borrar identificadores, literales y comentarios del cuerpo es lo que da valor
  a la señal: quien reimplementa una rutina nombra todo distinto, pero no puede
  evitar repetir el orden de los `if`, los bucles y las llamadas. Por eso un
  cuerpo muy parecido cuenta por sí solo aunque nombre y firma no coincidan.

  Sólo `duplicate` bloquea; `similar` y `unrelated` se informan y no frenan
  nada.

- **El índice se reconstruye en cada corrida y se descarta.** Cachearlo sería
  almacenamiento, y el almacenamiento de Actions es lo que ya costó una noche de
  checks en rojo cuando se agotó la cuota.

- **Exclusiones por defecto**, en ambos lados de la comparación: migraciones,
  código generado, `dist/`, `vendor/`, `*.d.ts` y `*.designer.*`; nombres que
  declaran forma y no comportamiento (`*Dto`, `*Request`, `*Mapper`,
  `*Settings`); y clases, interfaces, enums y componentes.

  Sólo se comparan métodos y funciones. Una clase se compara por una ventana
  acotada de sus primeras líneas, así que dos clases de servicio se parecen
  hagan lo que hagan; cuando una duplica de verdad a otra, lo dicen sus métodos,
  con cuerpo propio y una ubicación accionable.

- **Duplicación dentro del mismo PR.** Dos símbolos que la misma rama añade se
  comparan entre sí, el par se reporta una sola vez y el comentario dice de cuál
  de los dos casos se trata: «añadiste dos copias» se corrige distinto que «esto
  ya existía».

- `duplication` entra en la lista de checks por defecto. Con él, los seis checks
  que el README promete desde `v1.0.0` existen.

### Corregido

- **El workflow reusable fijaba sus propias composite actions en `@v2`.**
  Publicado como `v3` habría ejecutado los bundles del release anterior: todo lo
  que traen `3.0.0`, `3.1.0` y `3.2.0` —la resolución de tarea, los checks
  nuevos, la defensa contra inyección— habría sido invisible para el consumidor,
  sin nada en los logs que lo dijera.

  Un pin obsoleto no es un build roto; es un build correcto del código
  equivocado. Por eso además se añade `npm run check:pins`, que verifica que los
  pines coincidan con el major de `package.json`, y corre en CI y antes de mover
  el tag.

## [3.2.0] — 2026-07-28

### Añadido

- **Check `tests`.** Responde qué introduce el PR que ningún test menciona
  siquiera, en dos pasadas: una determinista que extrae los símbolos públicos
  nuevos y descarta los que ya aparecen en la suite, y el modelo solo sobre el
  resto. Sin esa primera pasada cada PR pagaría una llamada completa para
  responder algo que resuelve una búsqueda de texto.

  Que algo no tenga test no es un defecto por sí mismo: el check lo pide cuando
  el símbolo carga comportamiento, y no para DTOs, enums, constructores o
  delegación pura.

- **Extractores de símbolos** para C#, TypeScript/JavaScript, Vue y PHP, con
  expresiones regulares y **sin dependencias nuevas**. Un parser real metería
  binarios nativos o wasm en un bundle que corre en el CI de otros equipos; lo
  que las expresiones no ven produce menos hallazgos, nunca hallazgos falsos.

  En PHP un método sin palabra de visibilidad es público — al revés que en C#—,
  y los extractores lo tratan como tal.

- Un repositorio sin suite de tests **no incumple**: el check se omite
  declarando que no hay nada que cruzar. Se tienen en cuenta los archivos de
  test que existen pero aún no están commiteados, para que un PR que añade un
  símbolo y su test a la vez no reporte el símbolo como descubierto.

- `tests` entra en la lista de checks por defecto.

## [3.1.0] — 2026-07-28

### Añadido

- **Check `quality`.** Revisa cómo está construido el cambio: responsabilidad
  única, complejidad, naming, código muerto, manejo de errores, números mágicos
  e idempotencia. Es el único check con algo que decir sobre **cualquier** PR,
  incluidos los que no referencian ninguna tarea — que es el hueco que dejaba
  abierto omitir `criteria` en esos casos.

  No reporta vulnerabilidades: ese alcance sigue siendo exclusivo de `security`.
  Un hallazgo pertenece a un solo check, o el desarrollador tiene que decidir
  cuál de dos informes sobre la misma línea es el bueno.

  Bloquea solo en severidad alta. Una preferencia de naming no frena un merge.

- **Los checks de código se omiten en verde cuando el diff no toca código**, y
  el comentario declara por qué. Cuenta como código todo salvo documentación en
  texto plano y binarios: los YAML de workflow, los JSON de configuración,
  Terraform, Dockerfiles y SQL **sí se revisan**, porque ahí es donde viven los
  secretos embebidos.

  La clasificación se calcula sobre el `--stat` y no sobre el cuerpo del diff,
  para que «¿este PR toca código?» no dependa de cuánto cupo en el presupuesto.

- `quality` entra en la lista de checks por defecto.

## [3.0.0] — 2026-07-28

### Cambios incompatibles

- **La nomenclatura de rama deja de bloquear.** Un PR sin referencia de tarea
  ya no falla el check `criteria` con «No se pudo identificar la tarea»: se
  omite en verde y el resto de checks sigue corriendo y sigue pudiendo frenar el
  merge. El modo `invalid` de `task-ref.mjs` **se eliminó**, no se desactivó: la
  garantía de que nada bloquea por metadatos vive en que ese estado ya no
  existe.

  Cambia **cuándo** el gate bloquea, así que cualquiera fijado a `@v2` conserva
  el comportamiento anterior hasta que suba la referencia a `@v3`.

- Con ello desaparecen los prefijos exentos (`chore/`, `hotfix/`, `release/`,
  `dependabot/`, `renovate/`). Ya no hacen falta: no hay nada de lo que eximirse.

### Añadido

- **El id se resuelve bajo cualquier prefijo de rama.** El patrón es
  `<id>-slug`, así que `fix/3002-x` y `3002-x` valen igual que `feature/3002-x`.
  El título del PR resuelve también (`#3002`, `[3002]`, `(#3002)`), y el cuerpo
  como último recurso.
- **Ids adicionales como contexto.** Dentro de la fuente que gana, el primer id
  es el sujeto; los demás se descargan y viajan como trasfondo, sin que sus
  criterios se exijan nunca. Un cuerpo que diga «corrección de la incidencia
  #3002 de la tarea #3001» se evalúa contra la incidencia.
- **Desenlace de no-correspondencia.** Cuando el diff no tiene que ver con la
  tarea referenciada, el comentario lo dice con esas palabras y pide referenciar
  el id correcto, en vez de listar criterios incumplidos que nunca fueron suyos.
  El sesgo es conservador: ante la duda, corresponde y se evalúan los criterios.
- **Modo de criterios inferidos.** Una tarea sin criterios enumerados —una
  descripción de una línea es lo habitual— ya no queda fuera del gate: el modelo
  infiere qué pide y lo reporta. Como el contrato lo escribió el modelo y no la
  persona que definió la tarea, un cumplimiento parcial se informa como
  observación y no bloquea.
- **El gestor de tareas aporta estado, marcador de incidencia y tarea de
  origen**, todo en la misma consulta. Aditivo y tolerante: un despliegue que no
  los exponga sigue funcionando igual.
- **El título y el cuerpo del PR llegan al modelo.** Antes juzgaba si se hizo lo
  pedido sin leer lo que el desarrollador decía haber hecho.

### Seguridad

- **Todo texto escrito por el autor del PR viaja delimitado y rotulado como no
  confiable.** Es lo único del prompt que controla un tercero en una herramienta
  que decide merges. Los prompts declaran que es evidencia y jamás instrucción,
  la evidencia de un veredicto tiene que salir del diff, y hay una batería de
  tests que fija ambas propiedades.

### Corregido

- `htmlToText` no decodificaba entidades acentuadas: las descripciones llegaban
  al modelo con `aceptaci&oacute;n` literal, y el propio check no reconocía su
  encabezado de criterios.
- Una tarea sin descripción ya no es un error. Muchas llevan toda su intención
  en el título, y rechazarlas dejaba a esos PR sin validación alguna.

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
