import { useState, useEffect } from 'react'

interface QuestionItem {
  question: string
  steps: string[]
  answer: string
  sources?: string[]
  hasRewardLink?: boolean
}

const methodsQuestions: QuestionItem[] = [
  {
    question: '"How do I build my own LLM?"',
    steps: [
      'Writing...',
      'Thinking... Checking your data and goal...',
      'Researching... Picking a base model and recipe...',
      'Confirming... Training pipeline ready to launch...',
    ],
    answer:
      '"Pick a base model, point Nalu at your data, and click Train. Nalu chooses the hyperparameters, runs the loop, and ships you a packaged model. No CUDA flags, no YAML files. Build, test, and deploy in a single afternoon."',
  },
  {
    question: '"What if I don\'t have a GPU?"',
    steps: [
      'Writing...',
      'Thinking... Checking your hardware...',
      'Researching... Selecting cloud or local backend...',
      'Confirming... Free tier covers the first run...',
    ],
    answer:
      '"Train in the cloud directly from the browser, or run a small model on your laptop. Nalu auto-selects the right backend so you never think about it. The free browser tier covers small jobs; the desktop app unlocks bigger ones."',
  },
  {
    question: '"How big a dataset do I need?"',
    steps: [
      'Writing...',
      'Thinking... Looking at your task type...',
      'Researching... Checking quality vs. quantity tradeoffs...',
      'Confirming... A few thousand good examples is enough...',
    ],
    answer:
      '"Less than you think. For domain fine-tuning, a few thousand high-quality examples beats millions of noisy ones. Nalu shows you exactly which examples are helping the model and which are hurting it, so you can clean as you go."',
  },
]

const adviceQuestions: QuestionItem[] = [
  {
    question: '"I\'ve never built AI before. Where do I start?"',
    steps: [
      'Writing...',
      'Thinking... Loading a beginner template...',
      'Researching... Picking sensible defaults for you...',
      'Confirming... First model ready in under ten minutes...',
    ],
    answer:
      '"Open the browser app, pick a template, and answer five questions. Nalu writes the prompts, picks the model, and runs the first eval for you. You\'ll have a working AI assistant in under ten minutes. No ML knowledge required."',
  },
  {
    question: '"Can Nalu just build the AI for me?"',
    steps: [
      'Writing...',
      'Thinking... Parsing your goal in plain English...',
      'Researching... Drafting prompts and eval set...',
      'Confirming... Ready for you to review...',
    ],
    answer:
      '"Yes. Describe what you want in plain English (like \'a tutor for sixth-grade math\' or \'a code reviewer for our Python repo\') and Nalu picks the model, drafts the prompts, and assembles the eval set. You review, tweak, and ship."',
  },
  {
    question: '"What can I make for free in the browser?"',
    steps: [
      'Writing...',
      'Thinking... Reviewing the browser feature set...',
      'Researching... Checking the free-tier limits...',
      'Confirming... Everything in the browser is free...',
    ],
    answer:
      '"Ask anything, generate images, draft documents, and watch live artifacts come together as you go. Everything in the browser is free. You only pay when you download the desktop app to train your own LLM locally."',
  },
]

const reliabilityQuestions: QuestionItem[] = [
  {
    question: '"How does Nalu test against other AIs?"',
    steps: [
      'Writing...',
      'Thinking... Pulling latest benchmark results...',
      'Researching... Comparing head-to-head vs. closed models...',
      'Confirming... Nalu lands at the top of every category...',
    ],
    answer:
      '"On every public benchmark we run head-to-head against the major closed models, and across reasoning, coding, and instruction-following Nalu lands at the top. Every score is reproducible from the eval scripts shipped with the model."',
    sources: ['Public Eval Suite', 'Benchmark Reports', 'Head-to-Head Comparisons'],
  },
  {
    question: '"Can I trust the model I trained?"',
    steps: [
      'Writing...',
      'Thinking... Reviewing your training run...',
      'Researching... Running auto-evals and regression checks...',
      'Confirming... Model card generated automatically...',
    ],
    answer:
      '"Nalu runs evals automatically as you train, surfaces regressions before deploy, and writes the model card for you. You see exactly where your model wins and loses against the base. No guesswork, no spreadsheets."',
    sources: ['Auto Eval Reports', 'Regression Tracker', 'Generated Model Cards'],
  },
  {
    question: '"What about hallucinations?"',
    steps: [
      'Writing...',
      'Thinking... Checking hallucination benchmarks...',
      'Researching... Reviewing retrieval-augmented options...',
      'Confirming... Lower hallucination rate than closed models...',
    ],
    answer:
      '"Every release runs a hallucination eval suite, with retrieval-augmented modes you can flip on with one toggle. Out of the box, Nalu\'s hallucination rate measures lower than every major closed model on the public benchmarks."',
    sources: ['Hallucination Benchmarks', 'RAG Evaluation', 'Public Leaderboards'],
  },
]

const rewardQuestions: QuestionItem[] = [
  {
    question: '"Can I use Nalu inside my local IDE or coding agent?"',
    steps: [
      'Writing...',
      'Thinking... Checking IDE integration paths...',
      'Researching... Spinning up a local OpenAI-compatible endpoint...',
      'Confirming... Drop-in for any local IDE...',
    ],
    answer:
      '"Yes. The desktop app exposes any model you\'ve built as a local OpenAI-compatible endpoint. Point your IDE, plugin, or agent at it and you\'re using your own model. Same wire format, no rewrites."',
    hasRewardLink: true,
  },
  {
    question: '"What does the desktop app unlock?"',
    steps: [
      'Writing...',
      'Thinking... Reviewing desktop features...',
      'Researching... Checking what stays free in the browser...',
      'Confirming... Pay once, build forever...',
    ],
    answer:
      '"Local LLM training, full IDE integration, larger context windows, and offline use. Pay once, build forever. Your weights stay on your machine. The browser stays free for everyone."',
    hasRewardLink: true,
  },
  {
    question: '"Can I share the AI I build with my team?"',
    steps: [
      'Writing...',
      'Thinking... Looking at export options...',
      'Researching... Reviewing self-hosted endpoints...',
      'Confirming... Share via bundle or endpoint...',
    ],
    answer:
      '"Yes. Export your model as a self-contained bundle, hand it to a teammate, and it runs anywhere the desktop app does. Or host it on your own server and share an endpoint. You own what you build."',
    hasRewardLink: true,
  },
]

const questionsByType: Record<string, QuestionItem[]> = {
  methods: methodsQuestions,
  advice: adviceQuestions,
  reliability: reliabilityQuestions,
  reward: rewardQuestions,
}

interface Props {
  type?: 'advice' | 'reliability' | 'reward' | 'methods'
}

export default function UltraThinkDemo({ type = 'advice' }: Props) {
  const [currentQuestion, setCurrentQuestion] = useState(0)
  const [step, setStep] = useState(-1)
  const [typedQuestion, setTypedQuestion] = useState('')
  const [typedAnswer, setTypedAnswer] = useState('')

  const questions = questionsByType[type]
  const current = questions[currentQuestion]

  useEffect(() => {
    if (step === -1) {
      if (typedQuestion.length < current.question.length) {
        const timer = setTimeout(() => {
          setTypedQuestion(current.question.slice(0, typedQuestion.length + 1))
        }, 50)
        return () => clearTimeout(timer)
      } else {
        const timer = setTimeout(() => setStep(0), 500)
        return () => clearTimeout(timer)
      }
    }
  }, [typedQuestion, step, current.question])

  useEffect(() => {
    if (step === questions[currentQuestion].steps.length + 1) {
      if (typedAnswer.length < current.answer.length) {
        const timer = setTimeout(() => {
          setTypedAnswer(current.answer.slice(0, typedAnswer.length + 1))
        }, 30)
        return () => clearTimeout(timer)
      } else {
        const timer = setTimeout(() => {
          setCurrentQuestion((prev) => (prev + 1) % questions.length)
          setStep(-1)
          setTypedQuestion('')
          setTypedAnswer('')
        }, 3000)
        return () => clearTimeout(timer)
      }
    }
  }, [typedAnswer, step, current.answer, currentQuestion, questions])

  useEffect(() => {
    if (step >= 0 && step <= questions[currentQuestion].steps.length) {
      const timer = setTimeout(() => setStep(step + 1), 1500)
      return () => clearTimeout(timer)
    }
  }, [step, currentQuestion, questions])

  return (
    <div className="bg-white rounded-2xl border border-gray-200/60 shadow-sm text-left w-full max-w-[600px] min-h-[300px] mx-auto flex flex-col relative">
      <div className="px-6 md:px-8 py-5 border-b border-gray-100">
        <p className="text-xs font-light text-gray-400 mb-1.5">You</p>
        <p className="text-sm md:text-base text-gray-900 font-light leading-relaxed break-words">
          {typedQuestion}
          {step === -1 && typedQuestion.length < current.question.length && (
            <span className="animate-pulse text-gray-400">|</span>
          )}
        </p>
      </div>

      {step >= 0 && (
        <div className="px-6 md:px-8 py-5 flex-1">
          <p className="text-xs font-light text-gray-400 mb-2.5">Nalu</p>

          <div className="space-y-1.5 mb-4">
            {current.steps.map(
              (stepText, index) =>
                index < step && (
                  <p
                    key={index}
                    className="text-xs md:text-[13px] font-light text-gray-400 italic transition-opacity duration-500"
                  >
                    {stepText}
                  </p>
                )
            )}
          </div>

          {step > current.steps.length && current.answer && (
            <>
              <div className="border-l-2 border-blue-500 pl-4 mt-3 py-0.5">
                <p className="text-sm md:text-base text-gray-900 font-light leading-relaxed break-words">
                  {typedAnswer}
                  {typedAnswer.length < current.answer.length && (
                    <span className="animate-pulse text-gray-400">|</span>
                  )}
                </p>
              </div>

              {type === 'reward' && current.hasRewardLink && typedAnswer.length === current.answer.length && (
                <div className="mt-5 flex justify-center">
                  <button className="bg-gray-900 text-white text-xs font-medium px-5 py-2.5 rounded-full hover:bg-gray-700 transition-colors">
                    View Your Rewards &rarr;
                  </button>
                </div>
              )}

              {type === 'reliability' && current.sources && typedAnswer.length === current.answer.length && (
                <div className="mt-5 pt-4 border-t border-gray-100">
                  <p className="text-[11px] font-light text-gray-400 mb-2">Sources</p>
                  <div className="flex flex-wrap gap-1.5">
                    {current.sources.map((source, index) => (
                      <span
                        key={index}
                        className="text-[11px] font-light text-gray-500 bg-gray-50 border border-gray-200/80 px-2.5 py-1 rounded-full"
                      >
                        {source}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
