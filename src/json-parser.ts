'use strict';


import {routineEnter} from './routine';
import * as stream from 'stream';
import {createLiveMutexJSONParser, JSONParserOpts} from "@oresoftware/json-stream-parser";

//////////////////////////////////////////////////

export interface IParsedObject {
  [index: string]: any
}

// Uses the live-mutex-tuned parser (LiveMutexJSONParser) introduced in
// @oresoftware/json-stream-parser 0.1.x: a JSONParser subclass with a custom
// lmx line decoder and delayEvery backpressure. API-compatible with the old
// `new JSONParser(v)` at every call site (returns a stream.Transform that emits
// parsed objects on 'data').
export const createParser = function (v?: JSONParserOpts) {
  const routineId = 'ddl-routine-h_gbxCB0EhzFEXy8Oi';
  routineEnter(routineId, "createParser");
  return createLiveMutexJSONParser(v);
};
