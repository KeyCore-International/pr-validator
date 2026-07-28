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
