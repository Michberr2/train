// Only the trainer's final structured save receipt is a successful training run.
// Diagnostics, stderr, intermediate checkpoints, signals and nonzero exits fail.
export function samplerFromTrainingResult({status, signal, error, stdout = ''}) {
  if (status !== 0 || signal || error) return null
  const receipts = String(stdout).split('\n').filter(line => line.startsWith('NALU_TRAINING_RESULT '))
  if (receipts.length !== 1) return null
  try {
    const receipt = JSON.parse(receipts[0].slice('NALU_TRAINING_RESULT '.length))
    return receipt.schemaVersion === 1 && receipt.success === true && receipt.saved === true && receipt.validation?.completed === true && /^[a-f0-9]{64}$/.test(receipt.datasetSha256 || '') && /^tinker:\/\/[^\s]+\/sampler_weights\/[^\s]+$/.test(receipt.modelPath || '') ? receipt.modelPath : null
  } catch { return null }
}
