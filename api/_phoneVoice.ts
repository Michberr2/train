// Stable per-agent upgrades, verified against the live Telnyx voice catalog.
// Stored Polly IDs remain unchanged so rollback preserves every assignment.
export const NATURAL_PHONE_VOICES: Record<string, string> = {
  "Polly.Amy-Neural": "Telnyx.Ultra.1e9b9b3d-d2ce-4cac-9d05-bc36a63fa28e",
  "Polly.Brian-Neural": "Telnyx.Ultra.22df7143-7987-4e15-a720-d65c69a443b3",
  "Polly.Joanna-Neural": "Telnyx.Ultra.2747b6cf-fa34-460c-97db-267566918881",
  "Polly.Matthew-Neural": "Telnyx.Ultra.30894953-bcce-41fe-892c-15ce19c843ff",
  "Polly.Emma-Neural": "Telnyx.Ultra.fb02b554-7d64-4f90-841e-e57fc88f410c",
  "Polly.Olivia-Neural": "Telnyx.Ultra.2a12b36c-7f9b-4c3a-9f7a-72731b15323a",
  "Polly.Kendra-Neural": "Telnyx.Ultra.4111bc29-d7ff-4a15-90db-819f7b4f7706",
  "Polly.Joey-Neural": "Telnyx.Ultra.bbee10a8-4f08-4c5c-8282-e69299115055",
  "Polly.Salli-Neural": "Telnyx.Ultra.55deba52-bc73-4481-ab69-9c8831c8a7c3",
  "Polly.Kimberly-Neural": "Telnyx.Ultra.6ccbfb76-1fc6-48f7-b71d-91ac6298247b",
  "Polly.Arthur-Neural": "Telnyx.Ultra.ef191366-f52f-447a-a398-ed8c0f2943a1",
  "Polly.Danielle-Neural": "Telnyx.Ultra.c894559e-d529-4d70-a6fb-3330ecf7ef6b",
  "Polly.Gregory-Neural": "Telnyx.Ultra.565510e8-6b45-45de-8758-13588fbaec73",
  "Polly.Ruth-Neural": "Telnyx.Ultra.db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
  "Polly.Stephen-Neural": "Telnyx.Ultra.65209f8e-6140-4a20-b819-3cc2e21da19b",
  "Polly.Niamh-Neural": "Telnyx.Ultra.d79d2b77-9192-4e10-9407-5d43ca034803",
  "Polly.Aria-Neural": "Telnyx.Ultra.db408a93-859c-4a0a-b6a2-220c074cc90d",
  "Polly.Ayanda-Neural": "Telnyx.Ultra.692846ad-1a6b-49b8-bfc5-86421fd41a19",
  "Polly.Kajal-Neural": "Telnyx.Ultra.7ea5e9c2-b719-4dc3-b870-5ba5f14d31d8",
  "Polly.Jasmine-Neural": "Telnyx.Ultra.0d2162c2-2fe9-40a7-b3c1-43eab576a64b"
}

export function phoneVoiceName(polly: string): string {
  return process.env.NALU_PHONE_VOICE_QUALITY === 'ultra' ? NATURAL_PHONE_VOICES[polly] || polly : polly
}
