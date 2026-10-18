import { completeJson } from './api.mjs';
import { butterflyInstructions, butterflySchema, prepareButterflyInput } from './analysis.mjs';
import { selectionInstructions, selectionSchema } from './selection.mjs';
import { attachSources, prepareReferences } from './references.mjs';

export async function requestAnalysis(input, signal, context) {
    const sources = prepareReferences(input.sources || []);
    const result = await completeJson(context, butterflyInstructions, butterflySchema, { ...prepareButterflyInput(input), sources }, signal);
    return attachSources(result, sources);
}
export async function requestSelection(input, signal, context) {
    const sources = prepareReferences(input.sources || []);
    const result = await completeJson(context, selectionInstructions, selectionSchema, { ...input, sources }, signal);
    return attachSources(result, sources);
}
