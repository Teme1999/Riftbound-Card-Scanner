import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const upstreamHash = 'bd0c3e6448043de04f6a64a12cb7b759f78c3ab8f7c35c9f2e0f71c88bb17103';
const isOpenCv = id => id.replaceAll('\\', '/').endsWith('/@techstark/opencv-js/dist/opencv.js');

// The pinned upstream WASM is unchanged. Replace only four Emscripten JS
// binding factories with ordinary closures, preserving conversions/destructors.
// Do not permit dependency drift to silently restore runtime JS compilation.
export function makeCspOpenCv(source) {
  if (createHash('sha256').update(source).digest('hex') !== upstreamHash) throw new Error('OpenCV source changed; review its CSP binding adapter before updating.');
  const replace = (start, end, body) => {
    const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
    if(a<0||b<0)throw new Error('Missing pinned OpenCV binding factory');
    source=source.slice(0,a)+body+source.slice(b);
  };
  replace('function createNamedFunction(', 'function extendError(', `function createNamedFunction(name,body){
    var wrapped=function(){"use strict";return body.apply(this,arguments);};
    Object.defineProperty(wrapped,"name",{value:makeLegalFunctionName(name)});return wrapped;
  }`);
  replace('function makeDynCaller(', 'var fp;', `function makeDynCaller(dynCall){
    return function(){return dynCall.apply(null,[rawFunction].concat(Array.prototype.slice.call(arguments)));};
  }`);
  replace('function craftInvokerFunction(', 'function heap32VectorToArray(', `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){
    var argCount=argTypes.length;
    if(argCount<2)throwBindingError("argTypes array size mismatch");
    var method=argTypes[1]!==null&&classType!==null,needsStack=false;
    for(var i=1;i<argCount;i++)if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsStack=true;break;}
    var invoke=createNamedFunction(humanName,function(){
      if(arguments.length!==argCount-2)throwBindingError(humanName+" called with "+arguments.length+" arguments, expected "+(argCount-2));
      var destructors=needsStack?[]:null,wired=[cppTargetFunc];
      if(method)wired.push(argTypes[1].toWireType(destructors,this));
      for(var j=0;j<argCount-2;j++)wired.push(argTypes[j+2].toWireType(destructors,arguments[j]));
      var value=cppInvokerFunc.apply(null,wired);
      if(needsStack)runDestructors(destructors);
      else for(var k=method?1:2;k<argCount;k++)if(argTypes[k].destructorFunction!==null)argTypes[k].destructorFunction(wired[method?k:k-1]);
      return argTypes[0].name==="void"?undefined:argTypes[0].fromWireType(value);
    });
    Object.defineProperty(invoke,"length",{value:argCount-2});return invoke;
  }`);
  replace('function __emval_get_method_caller(', 'function __emval_get_property(', `function __emval_get_method_caller(argCount,argTypes){
    var types=__emval_lookupTypes(argCount,argTypes),retType=types[0];
    return __emval_addMethodCaller(function(handle,name,destructors,args){
      var values=[],offset=0;
      for(var i=1;i<argCount;i++){values.push(types[i].readValueFromPointer(args+offset));offset+=types[i].argPackAdvance;}
      var value=handle[name].apply(handle,values);
      for(var j=1;j<argCount;j++)if(types[j].deleteObject)types[j].deleteObject(values[j-1]);
      if(!retType.isVoid)return retType.toWireType(destructors,value);
    });
  }`);
  if (/new Function\(|new_\(Function|\beval\(/.test(source)) throw new Error('OpenCV still contains runtime code generation');
  return '/*! OpenCV JS binding adaptation for Riftbound Scanner. WASM unchanged. Apache-2.0; see NOTICE.md. */\n' + source;
}

export function opencvCspPlugin() {
  return {name:'opencv-static-bindings',enforce:'pre',transform(source,id){if(isOpenCv(id))return {code:makeCspOpenCv(source),map:null};}};
}

export function opencvCspOptimizer() {
  return {name:'opencv-static-bindings',setup(build){build.onLoad({filter:/[\\/]@techstark[\\/]opencv-js[\\/]dist[\\/]opencv\.js$/},async args=>({
    contents:makeCspOpenCv(await readFile(args.path,'utf8')),loader:'js',resolveDir:path.dirname(args.path),
  }));}};
}
