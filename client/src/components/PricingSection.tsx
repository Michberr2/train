const plans = [
  {
    label: 'Browser',
    price: 0,
    cents: '00',
    features: ['Ask anything, unlimited', 'Generate images & documents', 'Live artifacts in real time'],
  },
  {
    label: 'Desktop',
    price: 49,
    cents: 99,
    features: ['Build your own LLMs locally', 'Plug into any local IDE', 'Full offline use'],
  },
  {
    label: 'Studio',
    price: 99,
    cents: 99,
    features: ['Everything in Desktop', 'Priority cloud training', 'Dedicated support'],
  },
]

export default function PricingSection() {
  return (
    <div className="relative h-screen w-full flex flex-col">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/images/bg-meadow-sunset.png)' }}
      />

      <div className="h-28 md:h-32 flex-shrink-0" />

      <div className="relative z-10 flex-1 flex flex-col items-center md:justify-center w-full max-w-5xl mx-auto px-4 sm:px-6 pb-8 overflow-y-auto scrollbar-hide">
        <div className="w-full bg-white/90 dark:bg-white/95 backdrop-blur-xl rounded-2xl p-6 md:p-12 shadow-xl flex-shrink-0">
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-extralight text-gray-900 text-center mb-3 tracking-tight">
            Pricing
          </h1>
          <p className="text-sm md:text-base text-gray-400 text-center mb-12 font-light">
            Free in the browser. Pay once for the desktop app and your AI is yours forever.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {plans.map((plan) => (
              <div
                key={plan.label}
                className="bg-white rounded-2xl p-6 md:p-8 shadow-sm border border-gray-100"
              >
                <div className="mb-8">
                  <span className="inline-block px-4 py-1.5 text-sm text-gray-600 font-light bg-gray-100 rounded-full">
                    {plan.label}
                  </span>
                </div>

                <div className="mb-8">
                  <span className="text-5xl md:text-7xl font-extralight text-gray-900 tracking-tighter">${plan.price}</span>
                  <span className="text-lg md:text-xl font-extralight text-gray-900 relative -top-5 md:-top-7">.{plan.cents}</span>
                </div>

                <ul className="space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5">
                      <span className="text-gray-300 text-lg leading-none">·</span>
                      <span className="text-sm text-gray-500 font-light">{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
