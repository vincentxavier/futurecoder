// eslint-disable-next-line import/no-webpack-loader-syntax
import Worker from "worker-loader!./Worker.js";
import * as Comlink from 'comlink';
import {rpc} from "./rpc";
import {bookSetState, bookState, currentStepName, moveStep, ranCode} from "./book/store";
import {stateSet} from "./rpc/store";
import _ from "lodash";
import localforage from "localforage";
import {animateScroll} from "react-scroll";
import React from "react";

const pyodideAPI = Comlink.wrap(new Worker());
const inputTextArray = new Uint8Array(new SharedArrayBuffer(128 * 1024))
const inputMetaArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2))
const encoder = new TextEncoder();

export const terminalRef = React.createRef();

let awaitingInput = false;

localforage.config({name: "birdseye", storeName: "birdseye"});

const runCodeRemote = (entry, onSuccess) => {
  if (true || process.env.NODE_ENV === 'development') {  // TODO
    if (awaitingInput) {
      if (entry.source === "shell") {
        writeInput(entry.input);
      } else {
        // TODO interrupt
      }
    } else {
      pyodideAPI.runCode(entry, inputTextArray, inputMetaArray, Comlink.proxy(onSuccess));
    }
  } else {
    rpc("run_code", {entry}, onSuccess);
  }
}

export const runCode = ({code, source}) => {
  const shell = source === "shell";
  if (!shell && !code) {
    code = bookState.editorContent;
  }
  if (!code.trim()) {
    return;
  }
  bookSetState("processing", true);
  const entry = {input: code, source, page_slug: bookState.user.pageSlug, step_name: currentStepName()};

  const onSuccess = (data) => {
    if (data.error) {
      stateSet("error", {...data.error, data, method: "run_code"});
      return;
    }
    awaitingInput = data.awaiting_input;
    if (!shell) {
      terminalRef.current.clearStdout();
    }
    bookSetState("processing", false);

    if (source === "birdseye") {
      const {store, call_id} = data.birdseye_objects;
      delete data.birdseye_objects;
      Promise.all(
        _.flatMapDeep(
          _.entries(store),
          ([rootKey, blob]) =>
            _.entries(blob)
              .map(([key, value]) => {
                const fullKey = rootKey + "/" + key;
                return localforage.setItem(fullKey, value);
              })
        )
      ).then(() => {
        const url = "/static_backend/birdseye/index.html?call_id=" + call_id;
        if (bookState.prediction.state === "hidden") {
          window.open(url);
        } else {
          bookSetState("prediction.codeResult.birdseyeUrl", url);
        }
      });
    }

    ranCode(data);
    if (!data.prediction.choices) {
      showCodeResult(data);
      terminalRef.current.focusTerminal();
    }
  }

  runCodeRemote(entry, onSuccess);
}

const writeInput = (string) => {
  const bytes = encoder.encode(string);
  if (bytes.length > inputTextArray.length) {
    throw "Input is too long";  // TODO
  }
  inputTextArray.set(bytes, 0);  // TODO ensure no race conditions
  Atomics.store(inputMetaArray, 0, bytes.length);
  Atomics.store(inputMetaArray, 1, 1);
  Atomics.notify(inputMetaArray, 1);
}

export const showCodeResult = ({birdseyeUrl, output_parts, passed}) => {
  const terminal = terminalRef.current;
  terminal.pushToStdout(output_parts);
  animateScroll.scrollToBottom({duration: 30, container: terminal.terminalRoot.current});

  if (passed) {
    moveStep(1);
  }

  if (birdseyeUrl) {
    window.open(birdseyeUrl);
  }
}