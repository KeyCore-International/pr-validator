# Checks

Cada check es una unidad independiente: su propio prompt, su propia
configuración y su propio status check en GitHub. Un fallo en uno no afecta a
los demás.

## Semántica común

| Resultado | Significado | ¿Bloquea? |
| --- | --- | --- |
| `pass` | El check corrió y no encontró problemas | No |
| `fail` | El check corrió y encontró problemas | Según su configuración |
| `tool-error` | El check no pudo correr (gateway, red, credenciales) | **Nunca** |
| `skipped` | El check no aplicaba a este PR | No |

Un `tool-error` se declara solo tras 3 reintentos, que cubren tanto los fallos
de transporte como una respuesta del modelo ilegible o cortada a la mitad.

**Un fallo de infraestructura no bloquea nunca.** Un gateway caído no es un
defecto del código, y bloquear por él dejaría al equipo entero rehén de un
tercero.

## `criteria`

Valida el diff contra los criterios de aceptación de la tarea del PR.

El id de la tarea se busca en la rama (`feature/<id>-<slug>`) y, si no está,
en un bloque cercado ` ```criteria ` del cuerpo del PR. Con el id, se consulta
el gestor de tareas y se aplana la descripción a texto.

Cada criterio recibe un veredicto:

| Veredicto | Significado |
| --- | --- |
| `OK` | Cumplido, con evidencia `path:line` en el diff |
| `PARCIAL` | Implementado a medias |
| `FALTA` | Sin evidencia en el diff |
| `MANUAL` | Solo verificable ejecutando la aplicación |

**El comentario no reproduce el texto de la tarea.** Los criterios cumplidos
aparecen en una línea con su evidencia; solo los `PARCIAL` y `FALTA` llevan una
explicación corta de qué pide la tarea y qué falta, que es justo lo que el
developer necesita para corregir.

Si la tarea no tiene sección de criterios de aceptación, el diff se evalúa
contra el alcance descrito y se reporta como tal.

Bloquea por defecto.

## `security`

Revisa **solo el diff** buscando vulnerabilidades introducidas o tocadas por
él: inyección, autenticación y autorización rotas, secretos embebidos,
exposición de datos sensibles, validación de entrada ausente, deserialización
insegura, SSRF, XSS, path traversal y criptografía débil.

Cada hallazgo lleva severidad, ubicación `path:line` y la corrección concreta.
Un hallazgo de severidad alta falla el check.

No especula sobre código que no ve. Un revisor que opina sobre lo que no está
en el diff produce hallazgos que nadie puede accionar, y enseña al equipo a
ignorar el check.

Bloquea por defecto.

## `rules`

Juzga el diff contra las convenciones que el **propio repositorio** escribió,
en `.claude/rules/**`.

Cada regla relevante recibe `OK`, `INCUMPLE` o `N/A`. Las marcadas `N/A` no
aparecen en la tabla. Solo los incumplimientos llevan explicación.

Un repositorio sin reglas no "cumple": el check se omite indicando que no hay
convenciones que exigir.

El detalle declara qué archivos de reglas se cargaron. Si el corpus excede el
presupuesto, dice cuáles quedaron fuera — nunca trunca en silencio.

Bloquea por defecto.

## `quality`

Revisa **cómo está construido** lo que el diff introduce o toca: responsabilidad
única y cohesión, complejidad, naming, código muerto, manejo de errores, números
mágicos e idempotencia.

La idempotencia se reporta cuando volver a ejecutar el código produciría un
segundo cobro, una segunda fila o un segundo efecto: operaciones con reintento,
manejadores de mensajes, migraciones, endpoints que un cliente puede llamar dos
veces.

**No reporta vulnerabilidades.** Ese alcance es exclusivo de `security`. Un
hallazgo pertenece a un solo check: si el mismo problema saliera dos veces con
dos redacciones y a veces con dos severidades, el desarrollador tendría que
decidir cuál de los dos informes es el bueno.

Tampoco opina de estilo que ya impone un linter o un formateador.

La severidad es sobre consecuencia, no sobre gusto: `alta` para lo que va a
romper o corromper datos, `media` para una carga real de mantenimiento, `baja`
para pulido. **Solo la severidad alta bloquea** — bloquear por cada preferencia
de naming desde el primer día es como un gate enseña a que lo ignoren.

Es el único check que tiene algo que decir sobre **cualquier** PR, incluidos los
que no referencian ninguna tarea.

Bloquea por defecto, en severidad alta.

## `duplication`

Responde si algo que el PR introduce replica lógica que ya vive en el
repositorio.

Es el check más caro, porque es el único que necesita mirar más allá del diff:
para decir «esto ya existe» hay que saber qué existe. Trabaja en dos pasadas,
como `tests`:

1. **Determinista y gratis.** Indexa los símbolos públicos de todo el
   repositorio, y puntúa cada símbolo nuevo contra ese índice con tres señales:

   | Señal | Peso | Qué mide |
   | --- | --- | --- |
   | Cuerpo | 0,5 | El esqueleto de control tras borrar identificadores, literales y comentarios |
   | Nombre | 0,3 | Solapamiento de tokens, con sinónimos y plurales normalizados |
   | Firma | 0,2 | Aridad y tipos de los parámetros, y tipo de retorno |

   Sólo los pares que superan el umbral —0,55 por defecto, ajustable— llegan al
   modelo, con un tope de cinco candidatos por símbolo.

2. **Al modelo, sólo los pares que quedan.** Decide si cada uno es
   `duplicate`, `similar` o `unrelated`. Sólo `duplicate` bloquea.

Borrar los identificadores del cuerpo es lo que da valor a la señal: quien
reimplementa una rutina existente nombra todo distinto, pero no puede evitar
repetir el orden de los `if`, los bucles y las llamadas. Es el hallazgo que las
otras dos señales no pueden hacer, y por eso un cuerpo muy parecido cuenta por
sí solo aunque nombre y firma no coincidan.

**El índice se reconstruye en cada corrida y se descarta.** Cachearlo sería
almacenamiento, y el almacenamiento de Actions es justo lo que ya costó una
noche de checks en rojo cuando se agotó la cuota. Reconstruir cuesta segundos de
CPU del runner.

Quedan fuera por defecto, en ambos lados de la comparación:

- **Rutas** donde la repetición es el patrón: migraciones, código generado,
  `dist/`, `vendor/`, `node_modules/`, `*.d.ts`, `*.designer.*`.
- **Nombres** que declaran forma y no comportamiento: `*Dto`, `*Request`,
  `*Response`, `*Mapper`, `*Settings`, `*Options`.
- **Clases, interfaces, enums y componentes.** Sólo se comparan métodos y
  funciones. Una clase se compara por una ventana acotada de sus primeras
  líneas, así que dos clases de servicio se parecen hagan lo que hagan; cuando
  una duplica de verdad a otra, lo dicen sus métodos —con cuerpo propio y una
  ubicación accionable.

Dos símbolos que el **mismo PR** añade también se comparan entre sí. El par se
reporta una sola vez y el comentario dice de cuál de los dos casos se trata:
«añadiste dos copias» se corrige distinto que «esto ya existía».

Si nada supera el umbral —lo habitual— el check se omite en verde sin gastar
llamada al modelo.

Bloquea por defecto, sólo en `duplicate`.

## `tests`

Responde qué introduce el PR que ningún test menciona siquiera.

Trabaja en dos pasadas, y el orden es lo que lo hace asequible:

1. **Determinista y gratis.** Extrae los símbolos públicos que el diff añade
   —C#, TypeScript/JavaScript, Vue y PHP— y descarta todo aquel cuyo nombre
   aparezca en algún archivo de test del repositorio. La coincidencia es por
   palabra completa, para que un `Score` sin test no se esconda detrás de una
   mención a `ScoreCalculator`.
2. **Al modelo, solo el resto.** Decide cuáles de los símbolos huérfanos
   merecen un test y qué caso concreto debería cubrir.

Que algo no tenga test no es un defecto por sí mismo. El check pide test cuando
el símbolo carga comportamiento —reglas de negocio, cálculos, validaciones,
transiciones de estado, rutas de error— y no lo pide para DTOs, enums,
constructores, delegación pura o componentes sin lógica.

La extracción de símbolos usa expresiones regulares por lenguaje, sin
dependencias: un parser real metería binarios nativos en un bundle que corre en
el CI de otros equipos. Lo que las expresiones no ven produce **menos**
hallazgos, nunca hallazgos falsos.

Se ven también los archivos de test que existen pero aún no están commiteados,
para que un PR que añade un símbolo y su test a la vez no reporte el símbolo
como descubierto.

Un repositorio **sin suite de tests** no incumple: el check se omite indicando
que no hay nada que cruzar. Si todo lo nuevo ya está mencionado, se omite
igualmente y no gasta llamada al modelo.

Bloquea por defecto.

## Alcance por tipo de archivo

`security`, `quality`, `duplication` y `tests` **se omiten en verde cuando el
diff no toca código**, y el comentario dice por qué.

Cuenta como código todo salvo documentación en texto plano (`.md`, `.txt`,
`.rst`) y binarios. Los YAML de workflow, los JSON de configuración, Terraform,
Dockerfiles, SQL, lockfiles y scripts **sí se revisan**: la infraestructura
versionada es justo donde viven los secretos embebidos y los permisos mal
puestos.

La clasificación se calcula sobre el `--stat` del diff y no sobre su cuerpo,
para que la respuesta a «¿este PR toca código?» no dependa de cuánto del diff
cupo en el presupuesto.

## De dónde salen las reglas

`rules` no mira sólo una carpeta. Lee, en este orden:

1. `.claude/rules/**`
2. `.cursor/rules/**` y `.cursorrules`
3. `.github/copilot-instructions.md`
4. `CLAUDE.md`
5. `AGENTS.md`
6. `CONTRIBUTING.md`

**El orden es la política de presupuesto**: una carpeta que alguien creó *para
guardar reglas* dice más sobre las convenciones del repositorio que un archivo
raíz que además explica cómo correr los tests. Cuando el presupuesto se agota,
lo que se cae es la fuente más vaga.

### Prefiltro por relevancia

Una regla puede declarar a qué archivos aplica, con frontmatter:

```markdown
---
globs: src/**/*.vue
---
# Convenciones de componentes
```

Si el PR no toca ningún archivo que encaje, la regla se omite **antes** de
aplicar el presupuesto, y el comentario lo dice con ese motivo — distinto del
motivo «presupuesto», porque no son la misma noticia.

**Sólo se respeta el alcance que la regla declara sobre sí misma.** No se
adivina: descartar `frontend.md` porque el diff no trae `.vue` acabaría, algún
día, descartando justo la regla que el PR incumple. Un gate que se pierde lo que
le pidieron cazar es peor que uno que lee de más.

## Presupuestos y truncado

| Contexto | Presupuesto |
| --- | --- |
| Diff | 36.000 caracteres |
| Reglas | 48.000 caracteres |

El diff se corta en frontera de archivo, para que el modelo nunca vea medio
hunk y razone sobre código que no está completo. Las reglas se descartan por
archivo entero, porque media regla es peor que ninguna.

**Todo recorte se declara en el comentario**, con su magnitud: cuántos
caracteres de cuántos, y cuántos archivos quedaron fuera.
