import Workspace from "./Workspace";
import NimiqSignIn from "./NimiqSignIn";
import { useRegisterSW } from "virtual:pwa-register/react";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  DownloadSimple,
  List,
  X,
} from "@phosphor-icons/react";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
const currentPage = () => {
  const page = location.hash.slice(1) || "landing";
  return page === "app" ? "workspace" : page;
};

export default function Website() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const [page, setPage] = useState(currentPage),
    [menu, setMenu] = useState(false),
    [install, setInstall] = useState<InstallPrompt | null>(null),
    [online, setOnline] = useState(navigator.onLine);
  const go = (p: string) => {
    location.hash = p;
    setMenu(false);
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    const hash = () => {
      setPage(currentPage());
      setMenu(false);
    };
    const prompt = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallPrompt);
    };
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener("hashchange", hash);
    window.addEventListener("beforeinstallprompt", prompt);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    return () => {
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("beforeinstallprompt", prompt);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, []);
  useEffect(() => {
    if (page.startsWith("invite/"))
      sessionStorage.setItem("buylist.pending-invite", page.slice(7));
  }, [page]);
  return (
    <>
      <header className="site-header">
        <a href="#landing" className="wordmark" aria-label="Buylist home">
          buylist<span>.</span>
        </a>
        <button
          className="mobile-menu"
          aria-label="Toggle navigation"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X /> : <List />}
        </button>
        <nav className={menu ? "open" : ""} aria-label="Website navigation">
          {page === "workspace" ? (
            <button onClick={() => go("landing")}>About Buylist</button>
          ) : (
            <>
              <button onClick={() => go("login")}>Log in</button>
              <button className="site-cta" onClick={() => go("workspace")}>
                My plans
                <ArrowUpRight size={18} />
              </button>
            </>
          )}
          {install && (
            <button
              onClick={async () => {
                await install.prompt();
                const c = await install.userChoice;
                if (c.outcome === "accepted") setInstall(null);
              }}
            >
              <DownloadSimple />
              Install
            </button>
          )}
        </nav>
        <div id="site-account-slot" className="site-account-slot" />
      </header>
      {needRefresh && (
        <div className="offline-banner" role="status">
          An update is available.{" "}
          <button onClick={() => updateServiceWorker(true)}>Update</button>
        </div>
      )}
      {!online && (
        <div className="offline-banner" role="status">
          You’re offline. Reconnect to view or update your plans.
        </div>
      )}
      {page === "workspace" ? (
        <Workspace />
      ) : page.startsWith("invite/") ? (
        <main className="login-panel">
          <h1>You’re invited.</h1>
          <p>Sign in to join your group.</p>
          <NimiqSignIn onSuccess={() => go("workspace")} />
          <a className="site-cta" href="/api/auth/google/start">
            Continue with Google
          </a>
          <a className="underlink" href="#workspace">
            Already signed in? Open invitation
          </a>
        </main>
      ) : page === "login" ? (
        <main className="login-page">
          <section className="login-story">
            <h1>
              Good things.
              <br />
              <span>Within reach.</span>
            </h1>
            <p>A plan for the things you want, on your own or together.</p>
            <div className="login-art">
              <img src="/assets/sofa.svg" alt="Sofa illustration" />
            </div>
          </section>
          <section className="login-panel">
            <h2>
              Your plans
              <br />
              start here.
            </h2>
            <p>Sign in to create a plan or join your group.</p>
            <NimiqSignIn onSuccess={() => go("workspace")} />
            <a className="site-cta large" href="/api/auth/google/start">
              Continue with Google
              <ArrowRight size={22} />
            </a>
            <a className="underlink" href="#landing">
              Back to home
            </a>
          </section>
        </main>
      ) : (
        <main>
          <section className="landing-hero">
            <div className="hero-copy">
              <h1>
                Want it.
                <br />
                Plan it.
                <br />
                <span>Make it happen.</span>
              </h1>
              <p>
                Turn your wishlist into a plan. Set a target, find your pace,
                and contribute solo or with your people.
              </p>
              <div className="hero-actions">
                <button
                  className="site-cta large"
                  onClick={() => go("workspace")}
                >
                  Start a plan
                  <ArrowUpRight size={22} />
                </button>
              </div>
            </div>
            <div className="landing-illustration" aria-hidden="true">
              <div className="illustration-tile lime">
                <img src="/assets/tv.svg" alt="" />
                <span>Your next good thing.</span>
              </div>
              <div className="illustration-tile coral">
                <img src="/assets/sofa.svg" alt="" />
                <span>Better, together.</span>
              </div>
            </div>
          </section>
          <section className="how-section" id="how-it-works">
            <div className="section-heading">
              <h2>
                A little structure.
                <br />A lot to look forward to.
              </h2>
            </div>
            <div className="steps">
              <article>
                <span className="step-number">01</span>
                <h3>Pick your good thing.</h3>
                <p>Find a product or create your own goal.</p>
              </article>
              <article>
                <span className="step-number">02</span>
                <h3>Find your pace.</h3>
                <p>Choose contributions that work for you.</p>
              </article>
              <article>
                <span className="step-number">03</span>
                <h3>Get there together.</h3>
                <p>Invite your people and track your progress.</p>
              </article>
            </div>
          </section>
        </main>
      )}
      <footer className="site-footer">
        <a className="wordmark" href="#landing">
          buylist<span>.</span>
        </a>
        <span>Good things, planned.</span>
      </footer>
    </>
  );
}
