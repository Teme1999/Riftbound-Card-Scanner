import { resolveAppUrl } from './runtime.js';
import { rotateCardCanvas } from './cardRecognition.js';
import { parsePrintedCode } from './cardTextIdentity.js';
import { prepareTextPixels, textRows, isolateTextPixels } from './cardTextImage.js';
import { resolveRuneText } from './cardRuneVerification.js';
import { nativeRegistrationScale } from './cardArtworkRegistration.js';

function abortError() { return new Error('Text reading cancelled'); }

export function textRegions(card, { legacy = false, isolated = false } = {}) {
  const lower = card?.type === 'legend' || card?.type === 'rune';
  const landscape = card?.orientation === 'landscape';
  const rune = card?.type === 'rune';
  const nameWidth = rune ? .65 : Math.max(.42, Math.min(.87, String(card?.name || '').length * .032 + .22));
  if (legacy) return { landscape,
    name: { x: rune ? .20 : .065, y: landscape || lower ? .685 : .56, width: nameWidth, height: landscape || lower ? .105 : .085, legacy: true },
    footer: { x: .025, y: landscape ? .925 : .955, width: .40, height: landscape ? .055 : .035, legacy: true } };
  return { landscape, name: { x: rune ? .20 : .065, y: landscape || lower ? .65 : .52, width: nameWidth,
    height: landscape || lower ? .15 : .14, lines: String(card?.name||'').length>24?2:1, isolated: isolated && !rune && String(card?.name||'').length<=24 },
    // The detector can put the first set letter almost on the crop boundary.
    // Keep that margin: trimming 2.5% turned a visible RAD into AD on camera.
    footer: { x: 0, y: .92, width: .425, height: .075, isolated } };
}

// Find the text's vertical band inside the footer search area. Letter strokes
// produce many horizontal transitions; a card border produces very few. This
// keeps a small vertical detector offset from clipping the tops of RAD/OGN etc.
export function footerTextRows({ data, width, height }, padding = 2) {
  return textRows({ data, width, height }, padding);
}

// Separators and copyright fragments have their own OCR confidences. They must
// neither dilute nor inflate the confidence of the actual set/collector tokens.
export function recognizedTextLines(data, scale, footer) {
  const lines = (data.blocks || []).flatMap((block) => (block.paragraphs || []).flatMap((p) => p.lines || []));
  return lines.flatMap((line) => {
    if (!footer) {
      const words = (line.words || []).filter((word) => /[\p{L}\p{N}]/u.test(word.text));
      const runs = []; let run = [];
      for (const word of words) {
        if (word.confidence >= 90) run.push(word);
        else if (run.length) { runs.push(run); run = []; }
      }
      if (run.length) runs.push(run);
      return [{ text: words.length ? words.map((w) => w.text).join(' ') : line.text,
        confidence: words.length ? Math.min(...words.map((w) => w.confidence)) : line.confidence,
        sourceTextHeight: (line.bbox.y1 - line.bbox.y0) / scale }, ...runs.map((run) => ({
        text: run.map((word) => word.text).join(' '), confidence: Math.min(...run.map((word) => word.confidence)), partial: true,
        sourceTextHeight: Math.min(...run.map((word) => word.bbox.y1 - word.bbox.y0)) / scale }))];
    }
    const words = line.words || [];
    const readings = [];
    for (let i = 0; i < words.length; i++) {
      const set = words[i];
      if (parsePrintedCode(set.text)) readings.push({ text: set.text, confidence: set.confidence,
        sourceTextHeight: (set.bbox.y1 - set.bbox.y0) / scale });
      if (!/^[A-Z]{3}$/i.test(set.text)) continue;
      for (let j = i + 1; j < Math.min(words.length, i + 4); j++) {
        const token = words[j];
        if (!/^[A-Z]*\d+[A-Z]?\*?(?:\/\d+)?$/i.test(token.text)) continue;
        if (token.bbox.x0 - set.bbox.x1 > 200 * scale || Math.abs(token.bbox.y1 - set.bbox.y1) > 8 * scale) continue;
        readings.push({ text: `${set.text} ${token.text}`, confidence: Math.min(set.confidence, token.confidence),
          sourceTextHeight: Math.min(set.bbox.y1 - set.bbox.y0, token.bbox.y1 - token.bbox.y0) / scale });
      }
    }
    return readings.length ? readings : [{ text: line.text, confidence: line.confidence, sourceTextHeight: (line.bbox.y1 - line.bbox.y0) / scale }];
  });
}

export function prepareTextRegion(canvas, region, binary = false, footer = false) {
  const bounds = canvas.scanCardBounds || { x: 0, y: 0, width: 1, height: 1 };
  const leftMargin = footer && canvas.scanCardBounds ? .03 : 0;
  const bottomMargin=footer&&!region.legacy&&canvas.scanCardBounds ? .03 : 0;
  const cardHeight = canvas.height * bounds.height;
  const width = Math.max(1, Math.round(canvas.width * bounds.width * (region.width + leftMargin))), height = Math.max(1, Math.round(cardHeight * (region.height+bottomMargin)));
  const raw = document.createElement('canvas'); raw.width = width; raw.height = height;
  const context = raw.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, Math.round(canvas.width * (bounds.x + bounds.width * (region.x - leftMargin))),
    Math.round(canvas.height * (bounds.y + bounds.height * region.y)), width, height, 0, 0, width, height);
  const { image, rows: textRows } = prepareTextPixels(context.getImageData(0, 0, width, height), {
    binary: region.isolated ? false : binary, footer, localContrast: region.localContrast ? cardHeight * .011 : 0,
    localizedPolarity:region.localizedPolarity,goldInk:region.goldInk,
    padding: Math.max(footer ? 2 : 4, Math.round(cardHeight * (footer ? .003 : region.isolated ? .012 : .006))), maxLines: region.lines || 1, legacy: region.legacy });
  raw.width = image.width; raw.height = image.height;
  const pixels=context.createImageData(image.width,image.height);pixels.data.set(image.data);
  context.putImageData(pixels, 0, 0);
  const result = document.createElement('canvas');
  // Target readable character heights; huge source lettering also benefits from
  // downsampling. Upscaling never counts as additional source-image detail.
  const scale = binary && footer
    ? Math.max(.5, Math.min(3, 32 / (cardHeight * .014), 1800 / width))
    : Math.min(3, 1800 / width, footer || (region.legacy&&!region.isolated) ? 3 : (binary ? 32 : 44) / (cardHeight * .035));
  result.width = Math.round(image.width * scale) + 24; result.height = Math.round(textRows.height * scale) + 24;
  const ctx = result.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, result.width, result.height);
  ctx.drawImage(raw, 0, textRows.top, image.width, textRows.height, 12, 12, result.width - 24, result.height - 24);
  if(region.isolated){
    const isolated=isolateTextPixels(ctx.getImageData(0,0,result.width,result.height),{binary,footer,glyphHeight:cardHeight*(footer ? .014 : .035)*scale});
    result.width=isolated.width+30;result.height=isolated.height+30;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,result.width,result.height);
    const selected=ctx.createImageData(isolated.width,isolated.height);selected.data.set(isolated.data);ctx.putImageData(selected,15,15);
  }
  // Eligibility still depends on native region/glyph size, not the amount of
  // blank padding that row localization happened to retain.
  const nativeScale=nativeRegistrationScale(canvas,region);
  return { canvas: result, scale, nativeScale,sourceHeight: height*nativeScale };
}

export class CardTextReader {
  constructor({ createWorker = null, now = () => Date.now() } = {}) {
    this.createWorker = createWorker; this.now = now; this.worker = null; this.loading = null; this.generation = 0;
    this.recipe = null;
    this.runeRecipe = null;
  }
  async ensureReady() {
    if (this.worker) return this.worker;
    if (!this.loading) {
      const generation = this.generation;
      this.loading = (async () => {
        const factory = this.createWorker || (await import('tesseract.js')).createWorker;
        const worker = await factory('eng', 1, { workerPath: resolveAppUrl('/ocr/worker.min.js'),
          corePath: resolveAppUrl('/ocr/core'), langPath: resolveAppUrl('/ocr/lang'),
          cacheMethod: 'none', workerBlobURL: false, gzip: true, errorHandler: () => {} },
        { load_system_dawg: '0', load_freq_dawg: '0' });
        if (generation !== this.generation) { await worker.terminate(); throw abortError(); }
        this.worker = worker; return worker;
      })().catch((error) => { if (generation === this.generation) this.loading = null; throw error; });
    }
    return this.loading;
  }
  dispose() {
    this.generation++;
    this.recipe = null;
    this.runeRecipe = null;
    if (this.worker) {
      Promise.resolve(this.worker.terminate()).catch(() => {}); this.worker = null; this.loading = null;
    } else if (this.loading) {
      // Keep an unfinished factory shared until it settles. Starting a second
      // WASM initialization after a timeout would leave multiple workers alive.
      const pending = this.loading;
      pending.finally(() => { if (this.loading === pending) this.loading = null; }).catch(() => {});
    }
  }
  async read(canvas, { hint, index, signal, deadline = this.now() + 2000, alternativeCrops = [], runeArtwork = null }) {
    let timer, rejectAbort;
    const failure = new Promise((_, reject) => { rejectAbort = () => {
      // Cancel active recognition, but let shared background initialization
      // finish. A card/frame timeout must not repeatedly restart a cold WASM.
      if (this.worker) this.dispose();
      reject(abortError());
    };
      timer = setTimeout(rejectAbort, Math.max(0, deadline - this.now())); });
    // A rune pose change can invalidate a short OCR job without destroying the
    // warmed worker. Finish its current call, discard its reply, then service
    // the newest source. The deadline still force-terminates a stuck worker.
    const cancel = runeArtwork ? () => {} : rejectAbort;
    signal?.addEventListener('abort', cancel, { once: true });
    try { const result=await Promise.race([this.readWithinBudget(canvas, { hint, index, signal, deadline, alternativeCrops, runeArtwork }), failure]);
      if(signal?.aborted)throw abortError();return result; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  async readWithinBudget(canvas, { alternativeCrops = [], ...options }) {
    const readings = [];
    for (const [i, source] of [canvas, ...alternativeCrops].entries()) {
      if (options.signal?.aborted) throw abortError();
      if (this.now() >= options.deadline && readings.length) break;
      const cachedText = { nameLines: readings.filter(read => read.nameConfidence >= 90).map(read => ({ text: read.name, confidence: read.nameConfidence, partial: !read.nameCardIds?.length })),
        footerLines: readings.filter(read => read.codeConfidence >= 90).map(read => ({ text: read.code, confidence: read.codeConfidence })) };
      const result = { ...await this.readCrop(source, { ...options, cachedText }), textCropMethod: source?.scanRegistration ? 'artwork-registered' : source?.scanCardBounds ? 'obb+margin' : i === 0 ? 'obb' : 'perspective' };
      // A second crop of the same frame cannot erase trusted contradictory
      // text, and never counts as a second independent camera observation.
      const incompatible = (read, id) => id && ((read.codeCardId && read.codeCardId !== id) ||
        (read.nameCardIds?.length && !read.nameCardIds.includes(id)));
      if (result.status === 'conflict' || readings.some((read) => incompatible(read, result.cardId))) return { ...result, status: 'conflict', reason: 'crop-text-conflict' };
      if (result.status === 'confirmed' || incompatible(result, options.hint?.id)) return result;
      readings.push(result);
    }
    const fields = (read) => Number(Boolean(read.codeCardId)) + Number(read.nameConfidence >= 90);
    return readings.sort((a, b) => fields(b) - fields(a))[0];
  }
  async readCrop(canvas, { hint, index, signal, deadline, cachedText = null, runeArtwork = null }) {
    const cancelled = () => signal?.aborted || this.now() >= deadline;
    if (cancelled()) throw abortError();
    const worker = await this.ensureReady();
    if (cancelled()) throw abortError();
    const terminate = () => this.dispose();
    if(!runeArtwork)signal?.addEventListener('abort', terminate, { once: true });
    let tooSmall = false;
    const regionReads=[];
    const complete=result=>{
      if(result.status==='confirmed'){
        const name=regionReads.find(read=>!read.footer&&index.resolve({nameLines:read.lines}).matchedNameCardIds.includes(result.cardId));
        const footer=regionReads.find(read=>read.footer&&index.collector(read.lines)?.card?.id===result.cardId&&!index.collector(read.lines)?.ambiguousVariant);
        // Cache geometry/preprocessing only. No text, confidence or source
        // image is carried into another camera observation.
        if(name&&footer)this.recipe={hintId:hint?.id,padded:Boolean(canvas.scanCardBounds),aspect:canvas.width/canvas.height,
          name:name.recipe,footer:footer.recipe};
      }
      return result;
    };
    const readRegion = async (source, region, footer, preferredBinary=false) => {
      let best = [];
      for (const binary of [preferredBinary, !preferredBinary]) {
        if (cancelled()) throw abortError();
        const prepared = prepareTextRegion(source, region, binary, footer);
        if (prepared.sourceHeight < 10) { tooSmall = true; return []; }
        await worker.setParameters({ tessedit_pageseg_mode: region.block ? '6' : !footer && region.isolated && !binary ? '6' : footer || (!region.legacy && region.lines !== 2) ? '7' : '6',
          tessedit_char_whitelist: footer ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/* .\u00b7\u2022' : '' });
        const { data } = await worker.recognize(prepared.canvas, {}, { text: true, blocks: true });
        if (cancelled()) throw abortError();
        const lines = region.setOnly ? (data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>(p.lines||[]).flatMap(l=>(l.words||[]).map(word=>({
          text:word.text.trim().toUpperCase(),confidence:word.confidence,sourceTextHeight:(word.bbox.y1-word.bbox.y0)/prepared.scale}))))).filter(line=>
          /^[A-Z]{3}$/.test(line.text)&&index.cards.some(card=>card.set===line.text)) : recognizedTextLines(data, prepared.scale, footer);
        const usable = lines.map(line=>({...line,sourceTextHeight:line.sourceTextHeight*prepared.nativeScale})).filter((line) => {
          if (line.sourceTextHeight < 7) { tooSmall = true; return false; } return true;
        });
        const meaningful = region.setOnly ? usable.some(line=>line.confidence>=90) : footer ? Boolean(index.collector(usable)) : index.resolve({ nameLines: usable }).matchedNameCardIds.length > 0;
        if(meaningful)regionReads.push({footer,lines:usable,recipe:{region:{...region},binary,landscape:source!==canvas}});
        if (meaningful || usable.reduce((s, l) => s + l.confidence, 0) > best.reduce((s, l) => s + l.confidence, 0)) best = usable;
        if (meaningful) break;
      }
      return best;
    };
    const readLayout = async (legacy, isolated=false, cached=null) => {
      let regions = textRegions(hint, { legacy, isolated }), source = regions.landscape ? rotateCardCanvas(canvas) : canvas;
      const cachedCollector=cached&&index.collector(cached.footerLines);
      const footerLines = cachedCollector&&!cachedCollector.ambiguousVariant?cached.footerLines:await readRegion(source, regions.footer, true);
      const collector = index.collector(footerLines);
      if (collector) {
        regions = textRegions(collector.card, { legacy, isolated }); source = regions.landscape ? rotateCardCanvas(canvas) : canvas;
      }
      let nameLines = cached&&index.resolve({nameLines:cached.nameLines}).matchedNameCardIds.length?cached.nameLines:await readRegion(source, regions.name, false);
      // Unknown/partial metadata can still use the lower name band. It never
      // supplies an expected name, so this remains an independent text reading.
      if ((!hint?.type || !hint?.name) && !index.resolve({ nameLines }).matchedNameCardIds.length && !cancelled() && !regions.landscape && regions.name.y < .6) {
        nameLines = [...nameLines, ...await readRegion(source, textRegions({ type: 'legend' }, { legacy, isolated }).name, false)];
      }
      return { nameLines, footerLines, result: index.resolve({ nameLines, footerLines, tooSmall }) };
    };
    try {
      if(hint?.type==='rune'&&runeArtwork?.status==='rune-artwork'){
        const cachedRune=this.runeRecipe?.hintId===hint.id?this.runeRecipe:null;
        const alternateRune=/\d+a(?:\/\d+)?$/i.test(hint.code||'');
        const nameRegions=[...(cachedRune?[cachedRune.name]:[]),{...textRegions(hint).name,localizedPolarity:true},
          {x:.25,y:.67,width:.5,height:.12,localizedPolarity:true},
          ...(alternateRune?[{x:.3,y:.685,width:.4,height:.065,legacy:true,goldInk:true},
            {x:.3,y:.685,width:.4,height:.065,legacy:true}]:[]),
          {...textRegions(hint).name,x:.055,width:.85,height:.12,legacy:true,localContrast:true,block:true}];
        let nameLines=[],nameRegion;
        for(const region of nameRegions){
          nameLines.push(...await readRegion(canvas,region,false));nameRegion=region;
          if(resolveRuneText(index,{nameLines}).nameCardIds.length)break;
        }
        const regions=[...(cachedRune?[cachedRune.set]:[]),
          {x:.015,y:.89,width:.28,height:.105,setOnly:true},
          {x:.015,y:.89,width:.13,height:.105,setOnly:true,block:true},
          {x:.015,y:.94,width:.13,height:.055,setOnly:true,legacy:true},
          ...(alternateRune?[{x:.025,y:.955,width:.14,height:.04,setOnly:true,legacy:true},
            {x:.015,y:.955,width:.13,height:.035,setOnly:true,legacy:true}]:[]),
        ];
        let runeReading;
        for(const region of regions){
          const setLines=await readRegion(canvas,region,true,false);
          const resolved=resolveRuneText(index,{nameLines,setLines,artwork:runeArtwork});
          runeReading=resolved;
          if(['confirmed','conflict'].includes(resolved.status)){
            if(resolved.status==='confirmed')this.runeRecipe={hintId:hint.id,name:{...nameRegion},set:{...region}};
            return {...resolved,textLayout:'rune-name-set'};
          }
        }
        // Unreadable set/name text needs a fresh camera view, not a long full-ID
        // search that occupies the only OCR worker and starves the next frame.
        // Keep the full-code path for actual within-set printing ambiguity.
        if(runeReading?.reason!=='rune-printing-needs-full-code'||!runeReading.readSet)
          return {...runeReading,textLayout:'rune-name-set'};
      }
      let freshPreferred=null;
      const recipe=this.recipe;
      if(recipe&&recipe.hintId===hint?.id&&recipe.padded===Boolean(canvas.scanCardBounds)&&Math.abs(recipe.aspect-canvas.width/canvas.height)<.03){
        const source=field=>field.landscape?rotateCardCanvas(canvas):canvas;
        const footerLines=await readRegion(source(recipe.footer),recipe.footer.region,true,recipe.footer.binary);
        const nameLines=await readRegion(source(recipe.name),recipe.name.region,false,recipe.name.binary);
        freshPreferred={nameLines,footerLines};
        const result=index.resolve({...freshPreferred,tooSmall});
        if(['confirmed','conflict'].includes(result.status))return complete({...result,textLayout:'reused-regions'});
      }
      // Native camera crops commonly shift the small collector line outside
      // the legacy band. Try the broad localized bands first instead of
      // spending most of the deadline on two narrower failed layouts.
      if(canvas.scanCardBounds&&!freshPreferred){
        const localized=await readLayout(false,true,cachedText);
        if(['confirmed','conflict'].includes(localized.result.status))return complete({...localized.result,textLayout:'localized-first'});
        freshPreferred=localized;
      }
      const original = await readLayout(true, false, freshPreferred?{
        nameLines:[...(cachedText?.nameLines||[]),...freshPreferred.nameLines],
        footerLines:[...(cachedText?.footerLines||[]),...freshPreferred.footerLines]}:cachedText);
      if (['confirmed', 'conflict'].includes(original.result.status)) return complete({ ...original.result, textLayout: 'original' });
      if (cancelled()) throw abortError();
      const adaptive = await readLayout(false,false,original);
      const conflicting = (read, id) => id && ((read.codeCardId && read.codeCardId !== id) || (read.nameCardIds?.length && !read.nameCardIds.includes(id)));
      if (original.result.nameCardIds?.length && adaptive.result.nameCardIds?.length && !original.result.nameCardIds.some(id=>adaptive.result.nameCardIds.includes(id))) return { ...adaptive.result, status: 'conflict', reason: 'layout-text-conflict' };
      if (adaptive.result.status === 'conflict' || conflicting(original.result, adaptive.result.cardId)) return { ...adaptive.result, status: 'conflict', reason: 'layout-text-conflict' };
      let combinedLines={ nameLines: [...original.nameLines,...adaptive.nameLines], footerLines: [...original.footerLines,...adaptive.footerLines] };
      let combined = index.resolve({...combinedLines,tooSmall});
      let isolatedReading=null;
      if(combined.status==='unreadable'&&!cancelled()){
        const isolated=await readLayout(false,true,combinedLines);isolatedReading=isolated;
        if(isolated.result.nameCardIds?.length&&[original,adaptive].some(read=>read.result.nameCardIds?.length&&!read.result.nameCardIds.some(id=>isolated.result.nameCardIds.includes(id))))return{...isolated.result,status:'conflict',reason:'layout-text-conflict'};
        combined=index.resolve({nameLines:[...combinedLines.nameLines,...isolated.nameLines],footerLines:[...combinedLines.footerLines,...isolated.footerLines],tooSmall});
      }
      // Champion subtitles can outvote a short title during row localization.
      // Read the intact block as separate OCR lines before trying a lower band.
      if(combined.status==='unreadable'&&!combined.matchedNameCardIds.length&&!cancelled()&&String(hint?.name||'').length<=7&&!textRegions(hint).landscape&&textRegions(hint).name.y<.6){
        const region={...textRegions(hint,{legacy:true}).name,y:.50,height:.15,isolated:true};
        const upperName=await readRegion(canvas,region,false),current=isolatedReading||adaptive;
        combinedLines={nameLines:[...combinedLines.nameLines,...current.nameLines,...upperName],footerLines:[...combinedLines.footerLines,...current.footerLines]};
        combined=index.resolve({...combinedLines,tooSmall});
      }
      // Metadata does not identify every frame layout. Existing trusted title
      // readings and contradictions are never replaced by this fallback.
      if(combined.status==='unreadable'&&!combined.matchedNameCardIds.length&&!cancelled()&&!textRegions(hint).landscape&&textRegions(hint).name.y<.6){
        const lowerName=await readRegion(canvas,textRegions({type:'legend',name:hint?.name},{isolated:true}).name,false);
        const current=isolatedReading||adaptive;
        combined=index.resolve({nameLines:[...combinedLines.nameLines,...current.nameLines,...lowerName],footerLines:[...combinedLines.footerLines,...current.footerLines],tooSmall});
      }
      if (combined.status === 'unreadable' && !combined.codeCardId && !cancelled()) {
        const regions = textRegions(hint), source = regions.landscape ? rotateCardCanvas(canvas) : canvas;
        const footerLines = await readRegion(source, { ...regions.footer, y: .88, height: .13, isolated: true, localContrast: true }, true);
        const current = isolatedReading || adaptive;
        const nameLines = [...combinedLines.nameLines, ...current.nameLines];
        // Keep a successful lower/short-title read from this same source too.
        if (combined.nameConfidence >= 90) nameLines.push({ text: combined.name, confidence: combined.nameConfidence, partial: !combined.nameCardIds?.length });
        combined = index.resolve({ nameLines, footerLines: [...combinedLines.footerLines, ...current.footerLines, ...footerLines], tooSmall });
      }
      if (combined.status === 'unreadable' && !cancelled()) {
        const regions = textRegions(hint), source = regions.landscape ? rotateCardCanvas(canvas) : canvas;
        // An imperfect OBB or a stack behind a foreshortened card can move the
        // collector above the narrow footer band. Read the intact lower block
        // with local lighting normalization; parse only independently read IDs.
        const footerLines = combined.codeCardId ? [{ text: combined.code, confidence: combined.codeConfidence }] :
          await readRegion(source, { x: 0, y: .82, width: .44, height: .20, legacy: true, localContrast: true, block: true }, true);
        const nameLines = combined.nameConfidence >= 90 ? [{ text: combined.name, confidence: combined.nameConfidence, partial: !combined.nameCardIds?.length }] :
          await readRegion(source, { ...regions.name, x: .055, width: .85, height: .12, legacy: true, localContrast: true, block: true }, false);
        const current = isolatedReading || adaptive;
        combined = { ...index.resolve({ nameLines: [...combinedLines.nameLines, ...current.nameLines, ...nameLines],
          footerLines: [...combinedLines.footerLines, ...current.footerLines, ...footerLines], tooSmall }), textLayout: 'lighting-block' };
      }
      if (conflicting(original.result, combined.cardId) || conflicting(adaptive.result, combined.cardId) || (isolatedReading&&conflicting(isolatedReading.result,combined.cardId))) return { ...combined, status: 'conflict', reason: 'layout-text-conflict' };
      return complete({ ...combined, textLayout: combined.textLayout || (isolatedReading ? 'isolated' : 'combined') });
    } finally { signal?.removeEventListener('abort', terminate); }
  }
}
