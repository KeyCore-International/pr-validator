# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/): los tags `vX.Y.Z` son inmutables
y el tag `vX` se mueve al último release de ese major.

## [4.1.0] — 2026-07-30

Primer paso de la revisión de costes: hacer que el caching de prompt pueda
funcionar donde tiene sentido, y **poder medir si funciona**. Sin cambios en la
superficie pública — los `inputs` y `secrets` del workflow son los mismos.

### Añadido

- **El veredicto registra el desglose de tokens.** `meta.usage` trae ahora lecturas
  y escrituras de caché y tokens de razonamiento, cuando el proveedor los reporta.
  Antes `callGateway` recibía el objeto `usage` completo y el veredicto se quedaba
  solo con el total, lo que dejaba sin respuesta dos preguntas que deciden el
  siguiente movimiento de coste: si la caché acierta alguna vez, y cuánto de la
  factura es razonamiento. Un campo que el proveedor no reporta se omite en vez de
  guardarse como cero: «cero aciertos» y «este proveedor no lo dice» son respuestas
  distintas.
- **`callGateway` acepta `providerOptions`** y los reenvía al modelo.

### Cambiado

- **El prompt de `rules` empieza por el corpus, no por la cabecera.** El caching de
  prompt hace match de un prefijo desde el primer token, y la cabecera lleva el SHA
  del head: cambiaba en cada push, así que el prefijo divergía en el token cero y
  ninguna corrida podía reutilizar la anterior. El corpus —11–12k tokens de archivos
  de reglas idénticos entre corridas— pasa al principio.

  Es el único de los seis checks donde esto puede servir. El mínimo cacheable del
  proveedor son 1.024 tokens de prefijo estable y los system prompts de los otros
  cinco van de 329 a 892; su orden se deja como estaba en lugar de moverlo por un
  ahorro que no puede ocurrir.

  El corpus sigue en el mensaje de usuario y envuelto como entrada no confiable.
  Moverlo al system prompt cachearía igual de bien y le daría autoridad — que es
  justo lo que la auditoría de seguridad cerró en la versión anterior.

- **`promptCacheKey` por repositorio y check** en modelos de OpenAI, solo para
  `rules`. El ámbito es ese porque es donde el prefijo se repite; compartir una
  clave entre checks sería peor que ninguna, ya que sus system prompts difieren y
  los prefijos divergen igualmente.

### Nota sobre lo que esto todavía no demuestra

El TTL de caché de `gpt-5.6-luna` es de 30 minutos y no admite otro valor. Con
tráfico de PRs esporádico, que el prefijo sea cacheable no garantiza que se acierte.
Por eso este cambio entra junto con la medición y no al revés: `meta.usage` dirá si
hay aciertos antes de que nadie asuma el ahorro.

## [4.0.0] — 2026-07-29

Cierre de los 18 hallazgos de una auditoría de seguridad completa del código de
las fases A–F (informe en `CLAUDE-SECURITY-20260729-035355/`). El major es
obligatorio: varios ajustes **cambian el comportamiento para quien ya fijó `@v3`**
—ver «Cambios incompatibles».

### Cambios incompatibles

- **`.pr-validator.json` de la rama del PR ya no puede aflojar el gate.** El
  archivo se lee del checkout del *head*, o sea lo escribe quien abre el PR. Un
  `blocking: false` ahí desarmaba los seis checks con un solo archivo commiteado
  junto al código ofensivo, y todos los jobs seguían en verde. Ahora ese archivo
  puede **apretar** el gate, nunca aflojarlo, y todo presupuesto se acota entre un
  piso y un techo (`BOUNDS` en `src/context/config.mjs`).

  Un presupuesto también es un control del gate: `maxDiffChars: 1` dejaba al
  modelo razonando sobre un carácter y respondiendo PASS, más silencioso que
  `blocking: false` porque no imprimía ningún fallo.

  Lo rechazado se declara en el comentario: quien lo configuró merece leer por qué
  no tuvo efecto.

- **Una lista `checks` en `.pr-validator.json` ya no puede quitar checks.** Puede
  añadir; los que el validador publica como bloqueantes se reponen y la reposición
  se declara. El `checks` del workflow sí puede acotar: viene del repo consumidor
  en la rama base, que no es la rama en revisión.

- **Un corpus de reglas que el presupuesto tira ya no omite en verde.** `empty`
  distinguía «no escribió reglas» de «se descartó todo», y el segundo caso
  publicaba un motivo falso —«sin reglas declaradas»— con `CLAUDE.md` intacto en
  el árbol.

- **Un fallo causado por el contenido revisado ya no se reporta como fallo de
  infraestructura.** Un glob sin cerrar en un archivo de reglas, cuatro líneas,
  convertía un check bloqueante en «error de herramienta — no bloquea» y abortaba
  antes de llamar al modelo: nada del PR quedaba revisado. «Un tercero está caído»
  y «este PR no se pudo revisar» son afirmaciones distintas y sólo la primera es
  segura de dejar pasar. La política sigue intacta: la infraestructura nunca
  bloquea.

- **El bloque ` ```criteria ` del cuerpo del PR ya sólo vale si la tarea no se
  pudo obtener.** En la ruta de éxito sustituía los criterios de la tarea real
  —quien es evaluado escribía el contrato— y el comentario seguía encabezado con
  el id de la tarea real, así que un revisor lo leía como los criterios de verdad.

### Corregido

- **El gate de neutralidad no escaneaba los bundles commiteados**, la clase de
  archivo de mayor riesgo y justo la del incidente que documenta AGENTS.md.
  `.gitattributes` los marca `-diff`, git los trata como binarios y el `-I` de
  `git grep` los saltaba. La fuga histórica de este repositorio pasaba el gate
  hoy: reproducido contra `edf886e`, donde el bundle contenía una ruta absoluta
  del autor. Se cambia `-I` por `--text` y se añade `assertBundlesScanned()`, que
  sale 2 si un bundle no quedó cubierto.
- **Los archivos de reglas y de código se leían siguiendo symlinks**, exponiendo
  cualquier archivo legible por el runner al prompt y al gateway. Los rechazos se
  declaran en `omittedSources` en vez de encogar el corpus en silencio.
- **`untrustedBlock()` no neutralizaba su propio terminador**, así que el autor
  cerraba el bloque desde dentro.
- **El corpus de reglas entraba crudo al prompt** bajo un encabezado que el system
  prompt trataba como autoritativo. Ahora va envuelto, y `security` y `rules`
  tienen sección de entrada no confiable que cubre también el diff y el código
  citado.
- **Cuerpos de símbolos, firmas y rutas llegaban sin envolver a prompts
  bloqueantes.** Los cuerpos van en un fence más largo que cualquier racha de
  backticks que contengan; rutas, tipos y firmas se aplanan a una línea.
- **Retroceso cuadrático en la tokenización de nombres** fijaba una CPU del runner
  durante todo el timeout del job.
- **La detección de fork leía `head.repo.fork`**, así que en un repositorio que es
  a su vez un fork *todos* los PR se saltaban los seis checks bloqueantes. Y el
  corto-circuito de fork corre ahora antes de construir el contexto, no después:
  un PR desde fork ya no paga el índice de símbolos de un resultado que se
  descarta.
- **El `summary` del modelo se publicaba verbatim y sin límite** bajo la identidad
  del bot. El límite de 500 caracteres existía sólo como frase dentro del prompt,
  una instrucción que ningún código imponía. Ahora se acota y se escapa la
  estructura markdown de todos los campos.
- **El comentario consolidado se escribía en cualquier comentario que llevara el
  marcador**, y el marcador es una constante pública de un repositorio público.
  El autor del PR podía publicar el primero, ganarlo para siempre y editarlo
  después. Ahora sólo se actualiza un comentario de la propia identidad del token,
  y el listado pagina en vez de cortarse en 100.
- **El plugin `?raw` del build no verificaba contención**, así que un especificador
  de import podía leer cualquier archivo de la máquina de build e incrustarlo en un
  bundle público.
- **Una cabecera de archivo falsificada dentro de un archivo diffeado ocultaba
  símbolos nuevos** y omitía en verde `duplication` y `tests`. Una línea añadida
  cuyo contenido es `++ b/dev/null` llega al parser con la forma exacta de una
  cabecera. Ahora sólo se acepta una cabecera fuera de un hunk.
- **El índice de símbolos no tenía techo de símbolos**, sólo de archivos: 100
  archivos de declaraciones mínimas quedan muy por debajo del tope y producen más
  de un millón de entradas. Se añade techo declarado, pre-filtro aritmético que no
  puede perder un par válido, precómputo por símbolo, `statSync` antes de leer y
  presupuesto de reloj.
- **`release.yml` movía el tag mayor desde cualquier tag de versión empujado**, con
  los gates leídos de ese mismo árbol, así que se autoacreditaban. Se exige que el
  commit sea ancestro de la rama por defecto, con esa comprobación antes de
  ejecutar código del repositorio; `persist-credentials: false`, `--ignore-scripts`
  y token explícito sólo en el paso que empuja.

### Descartado

- `npm ci` ejecutando scripts de ciclo de vida en el job de release se reportó y se
  refutó 3/3: ese mismo job ya ejecuta JavaScript del repositorio con el mismo
  token, así que `--ignore-scripts` no cerraba nada por sí solo. Se añadió de todas
  formas como endurecimiento junto al resto de F14, no como el arreglo.

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
