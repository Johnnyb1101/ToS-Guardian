'use strict';

const C = require('./final-corpus-lib');

const DEFAULT_SMOKE_CAP = 500_000;
const CHECKPOINT_E_SMOKE_CAP = 6_080_000;
const CHECKPOINT_E_SCOPE_HASH = 'd6e429083b0d745526b9ed42e80f6e4c0acd2fe9a131637c85b5804d3b4b540a';
const CHECKPOINT_E_SAMPLE_ID = 'fastmail-privacy';
const CHECKPOINT_E_CONTEXT = Object.freeze({ anthropic: 1_000_000, openai: 128_000 });
const CHECKPOINT_E_OUTPUT = Object.freeze({ analyzer: 1200, critic: 1000 });
const CHECKPOINT_E_RATES = Object.freeze({
  anthropic: Object.freeze({ model: 'claude-sonnet-4-6', responseModel: 'claude-sonnet-4-6',
    inputMicrodollarsPerMillion: 3_000_000, outputMicrodollarsPerMillion: 15_000_000 }),
  openai: Object.freeze({ model: 'gpt-4o-mini', responseModel: 'gpt-4o-mini-2024-07-18',
    inputMicrodollarsPerMillion: 150_000, outputMicrodollarsPerMillion: 600_000 }),
});

function isCheckpointEActivation({ builds, classificationHash, sample }) {
  return C.digest({ builds, classificationHash, sample }) === CHECKPOINT_E_SCOPE_HASH;
}

module.exports = {
  DEFAULT_SMOKE_CAP, CHECKPOINT_E_SMOKE_CAP, CHECKPOINT_E_SCOPE_HASH, CHECKPOINT_E_SAMPLE_ID, CHECKPOINT_E_CONTEXT, CHECKPOINT_E_OUTPUT,
  CHECKPOINT_E_RATES, isCheckpointEActivation,
};
