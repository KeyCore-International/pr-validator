// Do two symbols have names that mean the same thing?
//
// `CalculateOrderTotal` and `computeOrderTotals` are the same idea written by
// two people. Comparing the strings says they share almost nothing; comparing
// their tokens says they share everything that matters.
//
// Teams that write in Spanish and English in the same repository add a second
// way to say the same thing: `formatearFecha` and `formatDate` are one routine.
// So every token is mapped to a canonical English word before it is compared,
// through one lexicon that holds both the English synonyms and the Spanish
// vocabulary developers actually use in identifiers.
//
// The signal is deliberately blunt. It ranks candidates for a model to look at,
// so a near miss costs one extra candidate — cheap — while missing an obvious
// pair costs the whole finding.

/**
 * Words that carry no meaning about WHAT a symbol does, in either language.
 *
 * `obtener` is Spanish for `get` and is dropped for the same reason: it is the
 * verb people reach for when they have nothing more specific to say.
 */
const STOP_WORDS = [
  // English
  'get',
  'set',
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'by',
  'with',
  'from',
  'and',
  'or',
  'is',
  'do',
  'my',
  'new',
  'obj',
  'data',
  'value',
  'item',
  'result',
  // Spanish articles, prepositions and connectors
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'lo',
  'para',
  'por',
  'con',
  'en',
  'al',
  'y',
  'o',
  'un',
  'una',
  'mi',
  'desde',
  'hasta',
  'segun',
  // Spanish words that carry as little as their English stop-word twins
  'obtener',
  'obtiene',
  'obten',
  'establecer',
  'establece',
  'es',
  'esta',
  'nuevo',
  'nueva',
  'dato',
  'valor',
  'resultado',
  'elemento',
  'objeto',
];

/**
 * Words different people pick for the same thing, mapped to one canonical word.
 *
 * English synonyms first, then Spanish. A Spanish entry maps to the English
 * word an English-speaking author would have used, so a Spanish name and its
 * English counterpart reduce to the same tokens. Plurals are not listed: they
 * are found by stripping `-s` and `-es` before the lookup.
 */
const SYNONYMS = {
  // English: verbs people pick for the same act
  calculate: 'compute',
  calc: 'compute',
  fetch: 'load',
  retrieve: 'load',
  read: 'load',
  build: 'create',
  make: 'create',
  generate: 'create',
  remove: 'delete',
  destroy: 'delete',
  check: 'validate',
  verify: 'validate',
  ensure: 'validate',
  convert: 'map',
  transform: 'map',
  parse: 'map',
  find: 'search',
  lookup: 'search',
  send: 'dispatch',
  total: 'sum',
  amount: 'sum',

  // Spanish verbs, in the forms that reach identifiers: the infinitive and the
  // third person used in imperative-style names such as `calculaTotal`.
  formatear: 'format',
  formatea: 'format',
  formato: 'format',
  calcular: 'compute',
  calcula: 'compute',
  calculo: 'compute',
  computar: 'compute',
  traer: 'load',
  trae: 'load',
  cargar: 'load',
  carga: 'load',
  leer: 'load',
  lee: 'load',
  recuperar: 'load',
  consultar: 'load',
  consulta: 'load',
  validar: 'validate',
  valida: 'validate',
  verificar: 'validate',
  verifica: 'validate',
  comprobar: 'validate',
  comprueba: 'validate',
  chequear: 'validate',
  asegurar: 'validate',
  crear: 'create',
  crea: 'create',
  generar: 'create',
  genera: 'create',
  construir: 'create',
  construye: 'create',
  armar: 'create',
  arma: 'create',
  eliminar: 'delete',
  elimina: 'delete',
  borrar: 'delete',
  borra: 'delete',
  quitar: 'delete',
  quita: 'delete',
  remover: 'delete',
  suprimir: 'delete',
  buscar: 'search',
  busca: 'search',
  encontrar: 'search',
  encuentra: 'search',
  hallar: 'search',
  enviar: 'dispatch',
  envia: 'dispatch',
  mandar: 'dispatch',
  manda: 'dispatch',
  convertir: 'map',
  convierte: 'map',
  transformar: 'map',
  transforma: 'map',
  parsear: 'map',
  parsea: 'map',
  mapear: 'map',
  mapea: 'map',
  guardar: 'save',
  guarda: 'save',
  almacenar: 'save',
  salvar: 'save',
  actualizar: 'update',
  actualiza: 'update',
  modificar: 'update',
  modifica: 'update',
  editar: 'update',
  edita: 'update',
  agregar: 'add',
  agrega: 'add',
  anadir: 'add',
  adicionar: 'add',
  insertar: 'add',
  mostrar: 'show',
  muestra: 'show',
  renderizar: 'show',
  desplegar: 'show',
  ocultar: 'hide',
  oculta: 'hide',
  esconder: 'hide',
  abrir: 'open',
  abre: 'open',
  cerrar: 'close',
  cierra: 'close',
  iniciar: 'start',
  inicia: 'start',
  comenzar: 'start',
  empezar: 'start',
  arrancar: 'start',
  terminar: 'stop',
  finalizar: 'stop',
  detener: 'stop',
  limpiar: 'clear',
  limpia: 'clear',
  reiniciar: 'reset',
  resetear: 'reset',
  ordenar: 'sort',
  ordena: 'sort',
  filtrar: 'filter',
  filtra: 'filter',
  agrupar: 'group',
  agrupa: 'group',
  contar: 'count',
  sumar: 'sum',
  suma: 'sum',
  restar: 'subtract',
  resta: 'subtract',
  multiplicar: 'multiply',
  dividir: 'divide',
  redondear: 'round',
  redondea: 'round',
  promediar: 'average',
  comparar: 'compare',
  compara: 'compare',
  copiar: 'copy',
  clonar: 'clone',
  mover: 'move',
  descargar: 'download',
  subir: 'upload',
  exportar: 'export',
  importar: 'import',
  imprimir: 'print',
  registrar: 'register',
  autenticar: 'authenticate',
  autorizar: 'authorize',
  asignar: 'assign',
  asigna: 'assign',
  aplicar: 'apply',
  aplica: 'apply',
  procesar: 'process',
  procesa: 'process',
  ejecutar: 'execute',
  ejecuta: 'execute',
  manejar: 'handle',
  maneja: 'handle',
  notificar: 'notify',
  normalizar: 'normalize',
  normaliza: 'normalize',
  sanitizar: 'sanitize',
  escapar: 'escape',
  codificar: 'encode',
  decodificar: 'decode',
  cifrar: 'encrypt',
  encriptar: 'encrypt',
  descifrar: 'decrypt',
  desencriptar: 'decrypt',
  serializar: 'serialize',
  deserializar: 'deserialize',
  redirigir: 'redirect',
  navegar: 'navigate',
  seleccionar: 'select',
  selecciona: 'select',
  cambiar: 'change',
  cambia: 'change',
  tiene: 'has',
  puede: 'can',
  listar: 'list',
  lista: 'list',
  listado: 'list',

  // Spanish nouns and adjectives
  fecha: 'date',
  hora: 'hour',
  tiempo: 'time',
  dia: 'day',
  mes: 'month',
  ano: 'year',
  anio: 'year',
  semana: 'week',
  edad: 'age',
  nacimiento: 'birth',
  inicio: 'start',
  fin: 'end',
  rango: 'range',
  intervalo: 'interval',
  moneda: 'currency',
  monto: 'sum',
  importe: 'sum',
  cantidad: 'quantity',
  precio: 'price',
  costo: 'cost',
  coste: 'cost',
  impuesto: 'tax',
  descuento: 'discount',
  saldo: 'balance',
  pago: 'payment',
  factura: 'invoice',
  pedido: 'order',
  orden: 'order',
  porcentaje: 'percent',
  tasa: 'rate',
  dinero: 'money',
  tarjeta: 'card',
  transaccion: 'transaction',
  cliente: 'customer',
  usuario: 'user',
  rol: 'role',
  permiso: 'permission',
  sesion: 'session',
  contrasena: 'password',
  clave: 'key',
  cuenta: 'account',
  empresa: 'company',
  agente: 'agent',
  nombre: 'name',
  apellido: 'surname',
  correo: 'email',
  telefono: 'phone',
  direccion: 'address',
  ciudad: 'city',
  pais: 'country',
  zona: 'zone',
  barrio: 'neighborhood',
  estado: 'status',
  tipo: 'type',
  categoria: 'category',
  producto: 'product',
  propiedad: 'property',
  inmueble: 'property',
  archivo: 'file',
  imagen: 'image',
  documento: 'document',
  mensaje: 'message',
  texto: 'text',
  cadena: 'string',
  numero: 'number',
  entero: 'integer',
  tabla: 'table',
  fila: 'row',
  columna: 'column',
  campo: 'field',
  formulario: 'form',
  boton: 'button',
  pagina: 'page',
  ruta: 'route',
  enlace: 'link',
  codigo: 'code',
  identificador: 'id',
  registro: 'record',
  historial: 'history',
  reporte: 'report',
  informe: 'report',
  resumen: 'summary',
  detalle: 'detail',
  configuracion: 'config',
  ajuste: 'setting',
  opcion: 'option',
  filtro: 'filter',
  respuesta: 'response',
  solicitud: 'request',
  peticion: 'request',
  servicio: 'service',
  evento: 'event',
  tarea: 'task',
  proyecto: 'project',
  contrato: 'contract',
  venta: 'sale',
  compra: 'purchase',
  carrito: 'cart',
  alquiler: 'rent',
  arriendo: 'rent',
  activo: 'active',
  activa: 'active',
  vacio: 'empty',
  vacia: 'empty',
  valido: 'valid',
  requerido: 'required',
  obligatorio: 'required',
  disponible: 'available',
  habilitado: 'enabled',
  deshabilitado: 'disabled',
  actual: 'current',
  siguiente: 'next',
  anterior: 'previous',
  primero: 'first',
  ultimo: 'last',
  maximo: 'max',
  minimo: 'min',
  barra: 'slash',
  guion: 'dash',
  punto: 'dot',
  coma: 'comma',
  espacio: 'space',
};

/**
 * One table for both kinds of entry. An empty canonical word means "drop it".
 *
 * Built once at load: every lookup below is a single `Map.get`.
 */
const CANONICAL = new Map([...Object.entries(SYNONYMS), ...STOP_WORDS.map((word) => [word, ''])]);

/** How many words the lexicon knows, stop-words included. */
export const LEXICON_SIZE = CANONICAL.size;

/**
 * Endings shared by a Spanish noun and the plural it makes with `-es`.
 *
 * `valor`/`valores`, `direccion`/`direcciones`, `ciudad`/`ciudades`: stripping
 * the `-es` gives the singular back. Stripping it from an English word does
 * not — `files` would become `fil` while `file` stayed `file`, and the two
 * would stop matching. So the rule covers both forms at once: a token ending
 * in one of these plus `-es` loses the `-es`, and a token ending in one of
 * these plus a bare `-e` loses the `-e`. `file`, `files`, `perfil` and
 * `perfiles` then all reduce to the same stem, and so do `store` and `stores`.
 * The stems are not words; they only have to agree.
 */
const SPANISH_ES_ENDINGS = ['dad', 'tad', 'or', 'al', 'el', 'il', 'ol', 'ar', 'er', 'on', 'us'];

/**
 * Hard bound on the text this file will look at.
 *
 * The extractors already cap what they store (`src/symbols/limits.mjs`), and
 * this repeats the ceiling at the sink so the guarantee holds whoever calls:
 * a name is scored against every indexed symbol, so its length must never be
 * the caller's to choose. Well past any identifier, so nothing real is cut.
 */
const MAX_NAME_CHARS = 200;

/** Split an identifier into meaningful lowercase tokens, in canonical English. */
export function tokenize(name) {
  return (
    String(name || '')
      .slice(0, MAX_NAME_CHARS)
      // `calcularÁrea`, `año`: an accented letter would otherwise split the
      // word in two. Decomposed, the base letter stays and the mark goes.
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      // camelCase and PascalCase boundaries, including acronym runs such as
      // `HTTPClient` -> `HTTP` + `Client`.
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      // One capital before a capitalised word, rather than the whole run of
      // capitals: `([A-Z]+)([A-Z][a-z])` splits at exactly the same places, but
      // gives its match back one character at a time at every start offset, so
      // a long run of capitals costs O(n^2). This form never backtracks.
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((token) => token.toLowerCase())
      .filter(Boolean)
      .map((token) => canonical(token))
      .filter(Boolean)
  );
}

/**
 * The canonical form of one lowercase token, or '' when it carries no meaning.
 *
 * The lexicon is consulted with the token as written and with its plural
 * stripped, so `usuarios`, `fechas` and `valores` find `usuario`, `fecha` and
 * `valor`. Whatever the lexicon does not know is stemmed, and so is whatever it
 * returns, so both sides of a comparison always end in the same form.
 */
function canonical(token) {
  for (const form of singularForms(token)) {
    const mapped = CANONICAL.get(form);
    if (mapped !== undefined) return mapped === '' ? '' : stem(mapped);
  }
  return stem(token);
}

/** The token, then the singulars it could be the plural of. */
function singularForms(token) {
  const forms = [token];
  if (token.length > 3 && token.endsWith('ies')) forms.push(`${token.slice(0, -3)}y`);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) forms.push(token.slice(0, -1));
  if (token.length > 4 && token.endsWith('es')) forms.push(token.slice(0, -2));
  return forms;
}

/**
 * Crude plural stripping: `totals` and `total`, `valores` and `valor`, are the
 * same word here. It promises one thing only — both forms of a word get the
 * same answer.
 */
function stem(token) {
  if (token.length <= 3) return token;

  for (const ending of SPANISH_ES_ENDINGS) {
    // At least one letter before the ending, so `ones` and `ore` are left to
    // the English rules rather than reduced to a bare ending.
    const min = ending.length + 1;
    if (token.endsWith(`${ending}es`) && token.length - 2 >= min) return token.slice(0, -2);
    if (token.endsWith(`${ending}e`) && token.length - 1 >= min) return token.slice(0, -1);
  }

  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  // `addresses` -> `address`; but `cases` -> `case`, which a blanket `-ses`
  // rule turned into `cas` while `case` stayed `case`.
  if (token.endsWith('sses')) return token.slice(0, -2);
  // `status`, `focus`, `bonus` are singular. Their plurals (`statuses`) and
  // the `-use` words (`cause`, `causes`) meet through the `us` ending above.
  if (token.endsWith('us')) return token;
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/**
 * Token overlap between two names, 0..1.
 *
 * Overlap coefficient rather than Jaccard: `SendInvoiceEmail` against
 * `SendEmail` should score high, and Jaccard punishes it for the extra word
 * even though one name plainly contains the other's meaning.
 */
export function nameSimilarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));

  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;

  return shared / Math.min(left.size, right.size);
}
