export default function PlatformSection() {
  return (
    <div className="relative h-screen w-full flex flex-col">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/images/bg-hills-teal.png)' }}
      />

      <div className="h-28 md:h-32 flex-shrink-0" />

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center w-full max-w-5xl mx-auto px-4 sm:px-6 pb-8">
        <h1 className="text-3xl md:text-4xl lg:text-5xl font-light text-white mb-8 md:mb-12 tracking-tight text-center drop-shadow-lg">
          One AI. Your whole screen. Anything you need.
        </h1>

        <div className="w-full max-w-3xl bg-white/90 dark:bg-white/95 backdrop-blur-xl rounded-2xl p-8 md:p-10 shadow-xl">
          <h2 className="text-xl md:text-2xl font-medium text-gray-900 mb-6 text-center">
            Nalu, your screen-wide assistant
          </h2>
          <p className="text-sm md:text-base text-gray-600 leading-relaxed mb-4">
            Hand Nalu the wheel and watch it work across every window. Clean up your inbox, finish your
            homework, book the trip, file the expenses, draft the doc. Nalu sees what you see and gets
            it done. Your personal assistant, running on your machine.
          </p>
          <p className="text-sm md:text-base text-gray-600 leading-relaxed">
            And when you want more than an assistant, build your own. Train custom LLMs without a line of
            ML code, plug them into any local IDE or coding agent, and ship a model that knows your data
            and your style. Free in the browser: ask, generate, draft, prototype. Pay once for the
            desktop app and the AI you build is yours forever.
          </p>
        </div>
      </div>
    </div>
  )
}
