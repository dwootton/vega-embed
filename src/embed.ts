import {applyPatch, Operation} from 'fast-json-patch';
import stringify from 'json-stringify-pretty-compact';
// need this import because of https://github.com/npm/node-semver/issues/381
import satisfies from 'semver/functions/satisfies';
import * as vegaImport from 'vega';
import {
  AutoSize,
  Config as VgConfig,
  EncodeEntryName,
  isBoolean,
  isString,
  Loader,
  LoaderOptions,
  mergeConfig,
  Renderers,
  SignalValue,
  Spec as VgSpec,
  TooltipHandler,
  View
} from 'vega';
import {expressionInterpreter} from 'vega-interpreter';
import * as vegaLiteImport from 'vega-lite';
import {Config as VlConfig, TopLevelSpec as VlSpec} from 'vega-lite';
import schemaParser from 'vega-schema-url-parser';
import * as themes from 'vega-themes';
import {Handler, Options as TooltipOptions} from 'vega-tooltip';
import post from './post';
import embedStyle from './style';
import {Config, ExpressionFunction, Mode} from './types';
import {mergeDeep} from './util';
import pkg from '../package.json';

export const version = pkg.version;

export * from './types';

export const vega = vegaImport;
export let vegaLite = vegaLiteImport;

// For backwards compatibility with Vega-Lite before v4.
const w = (typeof window !== 'undefined' ? window : undefined) as any;
if (vegaLite === undefined && w?.vl?.compile) {
  vegaLite = w.vl;
}

export interface Actions {
  export?: boolean | {svg?: boolean; png?: boolean};
  source?: boolean;
  compiled?: boolean;
  copySelection?: boolean;
  editor?: boolean;
}

export const DEFAULT_ACTIONS = {export: {svg: true, png: true}, source: true, compiled: true, editor: true};

export interface Hover {
  hoverSet?: EncodeEntryName;
  updateSet?: EncodeEntryName;
}

export type PatchFunc = (spec: VgSpec) => VgSpec;

const I18N = {
  CLICK_TO_VIEW_ACTIONS: 'Click to view actions',
  COMPILED_ACTION: 'View Compiled Vega',
  EDITOR_ACTION: 'Open in Vega Editor',
  PNG_ACTION: 'Save as PNG',
  SOURCE_ACTION: 'View Source',
  SVG_ACTION: 'Save as SVG',
  QUERY_ACTION: 'Copy Selection as Query'
};

export interface EmbedOptions<S = string, R = Renderers> {
  bind?: HTMLElement | string;
  actions?: boolean | Actions;
  mode?: Mode;
  theme?: 'excel' | 'ggplot2' | 'quartz' | 'vox' | 'dark';
  defaultStyle?: boolean | string;
  logLevel?: number;
  loader?: Loader | LoaderOptions;
  renderer?: R;
  tooltip?: TooltipHandler | TooltipOptions | boolean;
  patch?: S | PatchFunc | Operation[];
  width?: number;
  height?: number;
  padding?: number | {left?: number; right?: number; top?: number; bottom?: number};
  scaleFactor?: number;
  config?: S | Config;
  sourceHeader?: string;
  sourceFooter?: string;
  editorUrl?: string;
  hover?: boolean | Hover;
  i18n?: Partial<typeof I18N>;
  downloadFileName?: string;
  formatLocale?: Record<string, unknown>;
  timeFormatLocale?: Record<string, unknown>;
  expressionFunctions?: ExpressionFunction;
  ast?: boolean;
  expr?: typeof expressionInterpreter;
  viewClass?: typeof View;
}

const NAMES: {[key in Mode]: string} = {
  vega: 'Vega',
  'vega-lite': 'Vega-Lite'
};

const VERSION = {
  vega: vega.version,
  'vega-lite': vegaLite ? vegaLite.version : 'not available'
};

const PREPROCESSOR: {[mode in Mode]: (spec: any, config?: Config) => VgSpec} = {
  vega: (vgSpec: VgSpec) => vgSpec,
  'vega-lite': (vlSpec, config) => vegaLite.compile(vlSpec as VlSpec, {config: config as VlConfig}).spec
};

const SVG_CIRCLES = `
<svg viewBox="0 0 16 16" fill="currentColor" stroke="none" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
  <circle r="2" cy="8" cx="2"></circle>
  <circle r="2" cy="8" cx="8"></circle>
  <circle r="2" cy="8" cx="14"></circle>
</svg>`;

const CHART_WRAPPER_CLASS = 'chart-wrapper';
const COPY_ALERT_ID = 'copy-alert' + Math.random().toString(36).slice(-5);
export type VisualizationSpec = VlSpec | VgSpec;

export interface Result {
  /** The Vega view. */
  view: View;

  /** The input specification. */
  spec: VisualizationSpec;

  /** The compiled and patched Vega specification. */
  vgSpec: VgSpec;

  /** The Vega-Embed options. */
  embedOptions: EmbedOptions;

  /** Removes references to unwanted behaviors and memory leaks. Calls Vega's `view.finalize`.  */
  finalize: () => void;
}

function isTooltipHandler(h?: boolean | TooltipOptions | TooltipHandler): h is TooltipHandler {
  return typeof h === 'function';
}

function viewSource(source: string, sourceHeader: string, sourceFooter: string, mode: Mode) {
  const header = `<html><head>${sourceHeader}</head><body><pre><code class="json">`;
  const footer = `</code></pre>${sourceFooter}</body></html>`;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const win = window.open('')!;
  win.document.write(header + source + footer);
  win.document.title = `${NAMES[mode]} JSON Source`;
}

/**
 * Try to guess the type of spec.
 *
 * @param spec Vega or Vega-Lite spec.
 */
export function guessMode(spec: VisualizationSpec, providedMode?: Mode): Mode {
  // Decide mode
  if (spec.$schema) {
    const parsed = schemaParser(spec.$schema);
    if (providedMode && providedMode !== parsed.library) {
      console.warn(
        `The given visualization spec is written in ${NAMES[parsed.library]}, but mode argument sets ${
          NAMES[providedMode] ?? providedMode
        }.`
      );
    }

    const mode = parsed.library as Mode;

    if (!satisfies(VERSION[mode], `^${parsed.version.slice(1)}`)) {
      console.warn(
        `The input spec uses ${NAMES[mode]} ${parsed.version}, but the current version of ${NAMES[mode]} is v${VERSION[mode]}.`
      );
    }

    return mode;
  }

  // try to guess from the provided spec
  if (
    'mark' in spec ||
    'encoding' in spec ||
    'layer' in spec ||
    'hconcat' in spec ||
    'vconcat' in spec ||
    'facet' in spec ||
    'repeat' in spec
  ) {
    return 'vega-lite';
  }

  if ('marks' in spec || 'signals' in spec || 'scales' in spec || 'axes' in spec) {
    return 'vega';
  }

  return providedMode ?? 'vega';
}

function isLoader(o?: LoaderOptions | Loader): o is Loader {
  return !!(o && 'load' in o);
}

function createLoader(opts?: Loader | LoaderOptions) {
  return isLoader(opts) ? opts : vega.loader(opts);
}

function embedOptionsFromUsermeta(parsedSpec: VisualizationSpec) {
  const opts = (parsedSpec.usermeta as any)?.embedOptions ?? {};
  if (isString(opts.defaultStyle)) {
    // we don't allow styles set via usermeta since it would allow injection of logic (we set the style via innerHTML)
    opts.defaultStyle = false;
  }
  return opts;
}

window.addEventListener('copy', () => {
  if ((window as any).currentClicked) {
    const func = (window as any).currentClicked;
    func();
  }
});

const handleMouseEvent = (e: MouseEvent) => {
  // for any mouse down outside of vega element, clear
  (window as any).currentClicked = null;
  // Do something
};

window.addEventListener('mousedown', handleMouseEvent); // associate the function above with the click event

/**
 * Embed a Vega visualization component in a web page. This function returns a promise.
 *
 * @param el        DOM element in which to place component (DOM node or CSS selector).
 * @param spec      String : A URL string from which to load the Vega specification.
 *                  Object : The Vega/Vega-Lite specification as a parsed JSON object.
 * @param opts       A JavaScript object containing options for embedding.
 */
export default async function embed(
  el: HTMLElement | string,
  spec: VisualizationSpec | string,
  opts: EmbedOptions = {}
): Promise<Result> {
  let parsedSpec: VisualizationSpec;
  let loader: Loader | undefined;
  console.log('embedding dywootto!');
  if (isString(spec)) {
    loader = createLoader(opts.loader);
    parsedSpec = JSON.parse(await loader.load(spec));
  } else {
    parsedSpec = spec;
  }

  const loadedEmbedOptions = embedOptionsFromUsermeta(parsedSpec);
  const usermetaLoader = loadedEmbedOptions.loader;

  // either create the loader for the first time or create a new loader if the spec has new loader options
  if (!loader || usermetaLoader) {
    loader = createLoader(opts.loader ?? usermetaLoader);
  }

  const usermetaOpts = await loadOpts(loadedEmbedOptions, loader);
  const parsedOpts = await loadOpts(opts, loader);

  const mergedOpts = {
    ...mergeDeep(parsedOpts, usermetaOpts),
    config: mergeConfig(parsedOpts.config ?? {}, usermetaOpts.config ?? {})
  };

  return await _embed(el, parsedSpec, mergedOpts, loader);
}

async function loadOpts(opt: EmbedOptions, loader: Loader): Promise<EmbedOptions<never>> {
  const config: Config = isString(opt.config) ? JSON.parse(await loader.load(opt.config)) : opt.config ?? {};
  const patch: PatchFunc | Operation[] = isString(opt.patch) ? JSON.parse(await loader.load(opt.patch)) : opt.patch;
  return {
    ...(opt as any),
    ...(patch ? {patch} : {}),
    ...(config ? {config} : {})
  };
}

function getRoot(el: Element) {
  const possibleRoot = el.getRootNode ? el.getRootNode() : document;
  return possibleRoot instanceof ShadowRoot
    ? {root: possibleRoot, rootContainer: possibleRoot}
    : {root: document, rootContainer: document.head ?? document.body};
}

async function _embed(
  el: HTMLElement | string,
  spec: VisualizationSpec,
  opts: EmbedOptions<never> = {},
  loader: Loader
): Promise<Result> {
  const config = opts.theme ? mergeConfig(themes[opts.theme], opts.config ?? {}) : opts.config;

  const actions = isBoolean(opts.actions) ? opts.actions : mergeDeep<Actions>({}, DEFAULT_ACTIONS, opts.actions ?? {});
  const i18n = {...I18N, ...opts.i18n};

  const renderer = opts.renderer ?? 'canvas';
  const logLevel = opts.logLevel ?? vega.Warn;
  const downloadFileName = opts.downloadFileName ?? 'visualization';

  const element = typeof el === 'string' ? document.querySelector(el) : el;
  if (!element) {
    throw new Error(`${el} does not exist`);
  }

  if (opts.defaultStyle !== false) {
    const ID = 'vega-embed-style';
    const {root, rootContainer} = getRoot(element);
    if (!root.getElementById(ID)) {
      const style = document.createElement('style');
      style.id = ID;
      style.innerHTML =
        opts.defaultStyle === undefined || opts.defaultStyle === true
          ? (embedStyle ?? '').toString()
          : opts.defaultStyle;
      rootContainer.appendChild(style);
    }
  }

  const mode = guessMode(spec, opts.mode);

  let vgSpec: VgSpec = PREPROCESSOR[mode](spec, config);

  if (mode === 'vega-lite') {
    if (vgSpec.$schema) {
      const parsed = schemaParser(vgSpec.$schema);

      if (!satisfies(VERSION.vega, `^${parsed.version.slice(1)}`)) {
        console.warn(`The compiled spec uses Vega ${parsed.version}, but current version is v${VERSION.vega}.`);
      }
    }
  }

  element.classList.add('vega-embed');
  if (actions) {
    element.classList.add('has-actions');
  }
  element.innerHTML = ''; // clear container

  let container = element;
  if (actions) {
    const chartWrapper = document.createElement('div');
    chartWrapper.classList.add(CHART_WRAPPER_CLASS);
    element.appendChild(chartWrapper);
    container = chartWrapper;
  }

  const patch = opts.patch;
  if (patch) {
    vgSpec = patch instanceof Function ? patch(vgSpec) : applyPatch(vgSpec, patch, true, false).newDocument;
  }

  // Set locale. Note that this is a global setting.
  if (opts.formatLocale) {
    vega.formatLocale(opts.formatLocale);
  }

  if (opts.timeFormatLocale) {
    vega.timeFormatLocale(opts.timeFormatLocale);
  }

  // Set custom expression functions
  if (opts.expressionFunctions) {
    for (const name in opts.expressionFunctions) {
      const expressionFunction = opts.expressionFunctions[name];
      if ('fn' in expressionFunction) {
        vega.expressionFunction(name, expressionFunction.fn, expressionFunction['visitor']);
      } else if (expressionFunction instanceof Function) {
        vega.expressionFunction(name, expressionFunction);
      }
    }
  }

  const {ast} = opts;

  // Do not apply the config to Vega when we have already applied it to Vega-Lite.
  // This call may throw an Error if parsing fails.
  const runtime = vega.parse(vgSpec, mode === 'vega-lite' ? {} : (config as VgConfig), {ast});

  const view = new (opts.viewClass || vega.View)(runtime, {
    loader,
    logLevel,
    renderer,
    ...(ast ? {expr: (vega as any).expressionInterpreter ?? opts.expr ?? expressionInterpreter} : {})
  });

  view.addSignalListener('autosize', (_, autosize: Exclude<AutoSize, string>) => {
    const {type} = autosize;
    if (type == 'fit-x') {
      container.classList.add('fit-x');
      container.classList.remove('fit-y');
    } else if (type == 'fit-y') {
      container.classList.remove('fit-x');
      container.classList.add('fit-y');
    } else if (type == 'fit') {
      container.classList.add('fit-x', 'fit-y');
    } else {
      container.classList.remove('fit-x', 'fit-y');
    }
  });

  if (opts.tooltip !== false) {
    const handler = isTooltipHandler(opts.tooltip)
      ? opts.tooltip
      : // user provided boolean true or tooltip options
        new Handler(opts.tooltip === true ? {} : opts.tooltip).call;

    view.tooltip(handler);
  }

  let {hover} = opts;

  if (hover === undefined) {
    hover = mode === 'vega';
  }

  if (hover) {
    const {hoverSet, updateSet} = (typeof hover === 'boolean' ? {} : hover) as Hover;

    view.hover(hoverSet, updateSet);
  }

  if (opts) {
    if (opts.width != null) {
      view.width(opts.width);
    }
    if (opts.height != null) {
      view.height(opts.height);
    }
    if (opts.padding != null) {
      view.padding(opts.padding);
    }
  }

  await view.initialize(container, opts.bind).runAsync();

  let documentClickHandler: ((this: Document, ev: MouseEvent) => void) | undefined;

  if (actions !== false) {
    let wrapper = element;

    if (opts.defaultStyle !== false) {
      const details = document.createElement('details');
      details.title = i18n.CLICK_TO_VIEW_ACTIONS;
      element.append(details);

      wrapper = details;
      const summary = document.createElement('summary');
      summary.innerHTML = SVG_CIRCLES;

      details.append(summary);

      documentClickHandler = (ev: MouseEvent) => {
        if (!details.contains(ev.target as any)) {
          details.removeAttribute('open');
        }
      };
      document.addEventListener('click', documentClickHandler);
    }

    const ctrl = document.createElement('div');
    wrapper.append(ctrl);
    ctrl.classList.add('vega-actions');

    // add 'Export' action
    if (actions === true || actions.export !== false) {
      for (const ext of ['svg', 'png'] as const) {
        if (actions === true || actions.export === true || (actions.export as {svg?: boolean; png?: boolean})[ext]) {
          const i18nExportAction = (i18n as {[key: string]: string})[`${ext.toUpperCase()}_ACTION`];
          const exportLink = document.createElement('a');

          exportLink.text = i18nExportAction;
          exportLink.href = '#';
          exportLink.target = '_blank';
          exportLink.download = `${downloadFileName}.${ext}`;
          // add link on mousedown so that it's correct when the click happens
          exportLink.addEventListener('mousedown', async function (this, e) {
            e.preventDefault();
            const url = await view.toImageURL(ext, opts.scaleFactor);
            this.href = url;
          });

          ctrl.append(exportLink);
        }
      }
    }

    // add 'View Source' action
    if (actions === true || actions.source !== false) {
      const viewSourceLink = document.createElement('a');

      viewSourceLink.text = i18n.SOURCE_ACTION;
      viewSourceLink.href = '#';
      viewSourceLink.addEventListener('click', function (this, e) {
        viewSource(stringify(spec), opts.sourceHeader ?? '', opts.sourceFooter ?? '', mode);
        e.preventDefault();
      });

      ctrl.append(viewSourceLink);
    }

    // add 'View Compiled' action
    if (mode === 'vega-lite' && (actions === true || actions.compiled !== false)) {
      const compileLink = document.createElement('a');

      compileLink.text = i18n.COMPILED_ACTION;
      compileLink.href = '#';
      compileLink.addEventListener('click', function (this, e) {
        viewSource(stringify(vgSpec), opts.sourceHeader ?? '', opts.sourceFooter ?? '', 'vega');
        e.preventDefault();
      });

      ctrl.append(compileLink);
    }

    // add 'Open in Vega Editor' action
    if (actions === true || actions.editor !== false) {
      const editorUrl = opts.editorUrl ?? 'https://vega.github.io/editor/';
      const editorLink = document.createElement('a');

      editorLink.text = i18n.EDITOR_ACTION;
      editorLink.href = '#';
      editorLink.addEventListener('click', function (this, e) {
        post(window, editorUrl, {
          config: config as Config,
          mode,
          renderer,
          spec: stringify(spec)
        });
        e.preventDefault();
      });

      ctrl.append(editorLink);
    }

    // search through each dataset with _store ending, get selection names

    if (mode == 'vega-lite' || actions === true || actions.copySelection !== false) {
      if (actions !== true) {
        // add
        // if clicked on and haven't clicked on anything else
        console.log('adding copy!');
        // if a copy event fires and the container is clicked, copy the selection
        const copyAlert = document.createElement('div');
        copyAlert.id = COPY_ALERT_ID;
        copyAlert.innerHTML = 'Copied!';
        copyAlert.style.opacity = '0';
        copyAlert.style.fontFamily = 'Lato, Helvetica, sans-serif';
        copyAlert.style.color = 'white';
        copyAlert.style.margin = '0 auto';
        copyAlert.style.background = 'green';
        copyAlert.style.width = 'fit-content';

        element.appendChild(copyAlert);

        view.addEventListener('mousedown', function (event) {
          (window as any).currentClicked = () => {
            copyText();
          };
          event.preventDefault();
          event.stopPropagation();
        });

        const pandasLink = document.createElement('a');

        pandasLink.text = i18n.QUERY_ACTION;
        pandasLink.href = '#';
        function animateCopy() {
          document.getElementById(COPY_ALERT_ID)?.animate(
            [
              {opacity: '1', transform: 'translateY(-10px)'},
              {opacity: '0', transform: 'translateY(0px)'}
            ],
            {
              duration: 750,
              iterations: 1
            }
          );
        }

        const copyText = function () {
          const {data} = view.getState({data: vega.truthy, signals: vega.falsy, recurse: true});
          console.log('copying', data);
          // as selections store their data in a dataset with the suffix "*_store", find those selections
          const selectionNames = Object.keys(data)
            .filter((key) => key.includes('_store'))
            .map((key) => key.replace('_store', ''));

          const queries: Record<string, string[]> = {
            group: [],
            filter: []
          };

          for (const selection of selectionNames) {
            console.log('');
            if (!selection.includes('ALX')) continue;

            const signal = view.signal(selection);

            if (signal) {
              if (selection.includes('GROUP')) {
                console.log('about to group', signal);

                const group = createGroupFromSelectionName(selection, view);
                if (group !== '') {
                  queries.filter.push(group);
                }
              } else if (selection.includes('FILTER')) {
                const query = createQueryFromSelectionName(selection, view);
                if (query !== '') {
                  queries.filter.push(query);
                }
              }
            }
          }

          const filter_text = `df.query("${queries['filter'].join(' and ')}")
          `;

          const group_text = queries['group'].join(`
          `);

          const text = filter_text + group_text;
          console.log('your text', text);
          if (text.length > 0) {
            const copyPromise = copyTextToClipboard(text);
            copyPromise.then(
              function () {
                animateCopy();
              },
              function (err) {
                console.error('Async: Could not copy text: ', err);
              }
            );
          }

          //e.preventDefault();
        };

        pandasLink.addEventListener('click', copyText);

        ctrl.append(pandasLink);
      }
    }
  }

  function finalize() {
    if (documentClickHandler) {
      document.removeEventListener('click', documentClickHandler);
    }
    view.finalize();
  }

  return {view, spec, vgSpec, finalize, embedOptions: opts};
}

function cleanVegaProperties(source: any[], vgsidData: any[]) {
  const keys = Object.keys(source[0]);

  return keepKeys(vgsidData, keys);
}

function keepKeys(array: any[], keysToKeep: any[]) {
  return array.map((o) =>
    keysToKeep.reduce((acc, curr) => {
      acc[curr] = o[curr];
      return acc;
    }, {})
  );
}
function createGroupFromSelectionName(selectionName: string, view: View) {
  let query = '';

  const signal = view.signal(selectionName);

  if ('vlPoint' in signal) {
    const signalKeys = Object.keys(signal);
    const groupField = signalKeys.find((str) => str.includes('ALX_GROUP_COLUMN')) as string;

    const categoriesToGroup = signal[groupField];

    const mapping: Record<string, string> = {};
    for (const category of categoriesToGroup) {
      mapping[category] = 'Group';
    }
    const featureName = groupField.replace('ALX_GROUP_COLUMN_', '');
    query = `
ALX_MAP = ${JSON.stringify(mapping)}
df["ALX_GROUP"] = df["${featureName}"].map(ALX_MAP).fillna(df["${featureName}"])
df.groupby("ALX_GROUP").mean(numeric_only=True)
    `;
  }
  return query;
}

function createQueryFromSelectionName(selectionName: string, view: View) {
  const signal = view.signal(selectionName);
  console.log('post signal', signal);
  if ('vlPoint' in signal) {
    const selection = signal['vlPoint'];

    const vgsidToSelect = selection['or'].map((item: any) => item._vgsid_);

    const sourceName = 'source_0';
    const dataName = 'data_0';
    console.log('post signal', vgsidToSelect);

    const source = view.data(sourceName);

    const data = view.data(dataName);

    const selectedItems = cleanVegaProperties(
      source,
      data.filter((datum) => vgsidToSelect.includes(datum._vgsid_))
    );
    console.log('post selectedItems', selectedItems);

    const query = createQueryFromData(selectedItems);
    console.log('post query', vgsidToSelect);

    return query;

    // after selecting an item create filter
  } else {
    // interval selection
    // TODO: account for interval selection on ordinal

    //const selectionTuple = view.signal(selectionName + '_tuple_fields');
    let queries: string[] = [];

    // top level of _store object corresponds with the # of the selection (ie multi brush), this should typically be of length 1
    const selectionInstances = view.data(selectionName + '_store');
    console.log(' selectedInstances', selectionInstances);

    for (const selection of selectionInstances) {
      // if field is
      for (const fieldIndex in selection.fields) {
        const field = selection.fields[fieldIndex];
        if (field.type == 'E') {
          // ordinal and nominal interval selections
          console.log(' 751 selectedInstances', selectionInstances);

          selectionInstances.map((selectionInstance) => {
            const fieldName = field.field;
            // todo, make this
            const categoricalValues = selectionInstance.values[fieldIndex];

            queries.push(createQueryFromCategoricalInterval(fieldName, categoricalValues));
          });
        } else {
          // quantitative interval selections
          selectionInstances.map((selectionInstance) => {
            selectionInstance.fields[fieldIndex].field;
            const fieldName = field.field;
            const bounds = selectionInstance.values[fieldIndex].sort(function (a: number, b: number) {
              return a - b;
            });
            const [lowerBound, upperBound] = bounds;

            queries.push(createQueryFromBounds(fieldName, lowerBound, upperBound));
          });
          console.log(' 772', selectionInstances);
        }
      }
    }
    console.log(' about to join', queries);

    return queries.join(' and ');
  }

  // ordinal interval:
  // selection = {u:[3,4,5]} // ie all selected values

  // quant interval:
  // selection = {u:[3.2,5.3222222]} // ie bounds

  // TODO:
  // if point selection
  // select all of the fields on the data value
}

function createQueryFromData(data: any[]) {
  let stringConstructor: string[] = [];
  for (const datum of data) {
    let datumStringConstructor = [];
    const keys = Object.keys(datum);
    for (const key of keys) {
      datumStringConstructor.push(`${key.toString()}==${encodeValueAsString(datum[key])}`);
    }
    stringConstructor.push('(' + datumStringConstructor.join(' and ') + ')');
  }
  return '(' + stringConstructor.join(' or ') + ')';
}

function createQueryFromCategoricalInterval(field: string, data: string[]) {
  let stringConstructor: string[] = [];
  for (const datum of data) {
    stringConstructor.push(`${field.toString()}==${encodeValueAsString(datum)}`);
  }
  return ' (' + stringConstructor.join(' or ') + ') ';
}

function createQueryFromBounds(fieldName: string, lowerBound: number, upperBound: number) {
  return ` (${fieldName}>=${lowerBound.toFixed(2)} and ${fieldName}<=${upperBound.toFixed(2)}) `;
}

function encodeValueAsString(datumValue: any) {
  if (isString(datumValue)) {
    //@ts-ignore, as isNaN will determine if string can be parsed as number
    if (isNaN(datumValue)) {
      return "'" + datumValue + "'";
    }
  }
  return datumValue.toString();
}

//from https://stackoverflow.com/questions/400212/how-do-i-copy-to-the-clipboard-in-javascript
function fallbackCopyTextToClipboard(text: string) {
  var textArea = document.createElement('textarea');
  textArea.value = text;

  // Avoid scrolling to bottom
  textArea.style.top = '0';
  textArea.style.left = '0';
  textArea.style.position = 'fixed';

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    var successful = document.execCommand('copy');
    if (successful) {
      return Promise.resolve('successful');
    } else {
      return Promise.reject('unsuccessful');
    }
  } catch (err) {
    console.error('Fallback: Oops, unable to copy', err);
  }
  document.body.removeChild(textArea);

  return Promise.reject('unsuccessful');
}
function copyTextToClipboard(text: string) {
  if (!navigator.clipboard) {
    return fallbackCopyTextToClipboard(text);
  }
  return navigator.clipboard.writeText(text);
}
