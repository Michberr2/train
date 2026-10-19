import asyncio
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import torch
import train_catalina_dro as dro
import train_nalu_sft as sft

class TrainingCorrectness(unittest.TestCase):
    def test_dro_prompt_gradient_is_zero_and_completion_gradient_matches_objective(self):
        rollout = dro._make_datum([1, 2, 3], [4, 5], [-1., -2.], 2.)
        self.assertEqual(rollout.datum.model_input.to_ints(), [1, 2, 3, 4])
        self.assertEqual(rollout.datum.loss_fn_inputs['target_tokens'].data, [2, 3, 4, 5])
        values = torch.tensor([-900., -0.5, -1.3, -1.6], dtype=torch.float64, requires_grad=True)
        loss, metrics = dro.masked_dro_loss([rollout], [values], 0.05)
        loss.backward()
        self.assertTrue(torch.allclose(values.grad, torch.tensor([0., 0., -2.015, -1.98], dtype=torch.float64)))
        self.assertAlmostEqual(loss.item(), 5.80625)
        self.assertEqual(metrics['completion_tokens'], 2)

    def test_zero_advantage_keeps_only_completion_regularizer(self):
        rollout = dro._make_datum([1, 2], [3], [-1.], 0.)
        values = torch.tensor([-100., -2.], requires_grad=True)
        loss, _ = dro.masked_dro_loss([rollout], [values], 0.2)
        loss.backward()
        self.assertEqual(values.grad[0].item(), 0.)
        self.assertAlmostEqual(values.grad[1].item(), -0.2)

    def test_sampling_reference_missing_extra_nonfinite_and_positive_rejected(self):
        for logprobs in ([], [-1., -2.], [float('nan')], [float('inf')], [0.2]):
            with self.assertRaises(ValueError): dro._make_datum([1], [2], logprobs, 1.)
        with self.assertRaises(ValueError): dro._make_datum([], [2], [-1.], 1.)

    def test_resolves_async_sdk_future_before_using_result(self):
        class Future:
            async def result_async(self): return {'resolved': True}
        async def method(): return Future()
        self.assertEqual(asyncio.run(dro._resolve(method())), {'resolved': True})

    def test_incomplete_sample_never_fabricates_logprobs(self):
        class Sequence:
            tokens = [7, 8]
            logprobs = [-1.]
        class Result: sequences = [Sequence()]
        class Client:
            async def sample_async(self, **_kwargs): return Result()
        with self.assertRaises(ValueError): asyncio.run(dro.sample_group(Client(), [1, 2], dro.Config(group_size=1)))

    def test_custom_loss_uses_documented_sdk_target_only_contract(self):
        rollouts = [dro._make_datum([1, 2], [3], [-1.], 1.)]
        class Client:
            async def forward_backward_custom_async(self, data, loss_fn):
                self_data = data[0]
                self_keys = set(self_data.loss_fn_inputs)
                assert self_keys == {'target_tokens'}
                loss, _ = loss_fn(data, [torch.tensor([-99., -1.], requires_grad=True)])
                return float(loss.detach())
        self.assertEqual(asyncio.run(dro.forward_backward(Client(), rollouts, dro.Config())), 1.)

    def test_ground_truth_reward_rejects_lexical_hacks_wrong_values_and_extra_claims(self):
        task = {'expected': {'amount': 10}}
        self.assertEqual(dro.reward_fn(task, '{"amount":10.0}'), 1.)
        for text in ['Because source according to http://fixture.test therefore ' * 20, '{"amount":100}', '{"amount":true}', '{"amount":10,"unsupported":true}', '{"amount":NaN}']:
            self.assertEqual(dro.reward_fn(task, text), 0.)

    def test_train_and_evaluation_cannot_share_ids_or_normalized_prompts(self):
        train = [{'id': 'a', 'prompt': 'Compute 10 + 2'}]
        dro.validate_disjoint_tasks(train, [{'id': 'b', 'prompt': 'Compute 17 + 9'}])
        for other in ({'id': 'a', 'prompt': 'Another prompt'}, {'id': 'b', 'prompt': ' COMPUTE 10   + 2 '}):
            with self.assertRaises(ValueError): dro.validate_disjoint_tasks(train, [other])

    def test_long_sft_examples_are_not_sliced_into_incoherent_token_tails(self):
        class Tokenizer:
            def encode(self, text): return list(text.encode())
        row = {'system': 'IMPORTANT instruction', 'user': 'Question with essential context', 'assistant': 'Answer'}
        self.assertEqual(sft.encode_chatml([row], Tokenizer(), 20), [])
        full = sft.encode_chatml([row], Tokenizer(), 1000)
        self.assertEqual(len(full), 1)
        self.assertIn('IMPORTANT instruction', bytes(full[0].model_input.to_ints()).decode())

    def test_invalid_dataset_fails_before_remote_client_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'unreviewed.jsonl'
            data.write_text(json.dumps({'system': 'fixture', 'user': 'task', 'assistant': 'answer'}) + '\n')
            with patch.object(sys, 'argv', ['train_nalu_sft.py', '--domain', 'math', '--data', str(data)]), patch.object(sft.tinker, 'ServiceClient', side_effect=AssertionError('remote client created')):
                with self.assertRaisesRegex(ValueError, 'not eligible'): sft.main()

    def test_missing_loss_cannot_be_a_successful_validation(self):
        class Result: metrics = {}
        with self.assertRaises(RuntimeError): sft.measured_loss(Result(), 1)

if __name__ == '__main__': unittest.main()
