import { FluidSimulation } from "@/components/fluid-simulation"

export default function Page() {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-background text-foreground">
      {/* WebGL fluid simulation background */}
      <FluidSimulation />

      {/* subtle vignette so foreground text stays legible over bright dye */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,oklch(0.12_0_0/0.7)_100%)]"
      />

      {/* foreground content */}
      <div className="pointer-events-none relative z-10 flex min-h-dvh flex-col">
        <header className="flex items-center justify-between p-6 md:p-8">
          <span className="font-mono text-sm tracking-widest text-foreground/80">
            FLUX
          </span>
          <span className="font-mono text-xs tracking-widest text-foreground/50">
            WEBGL / NAVIER&ndash;STOKES
          </span>
        </header>

        <section className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="mb-6 font-mono text-xs uppercase tracking-[0.3em] text-foreground/60">
            Move your cursor
          </p>
          <h1 className="max-w-4xl text-balance text-5xl font-semibold leading-[1.05] tracking-tight md:text-7xl lg:text-8xl">
            Fluid in real time
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-base leading-relaxed text-foreground/70 md:text-lg">
            A GPU-accelerated fluid solver running entirely in your browser. Drag
            across the screen to push dye through the velocity field.
          </p>
        </section>

        <footer className="flex flex-col items-center gap-1 p-6 md:flex-row md:justify-between md:p-8">
          <span className="font-mono text-xs tracking-widest text-foreground/40">
            128 SIM &middot; 1024px DYE
          </span>
          <span className="font-mono text-xs tracking-widest text-foreground/40">
            CLICK &amp; DRAG TO PAINT
          </span>
        </footer>
      </div>
    </main>
  )
}