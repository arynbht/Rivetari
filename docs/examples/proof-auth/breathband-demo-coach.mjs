// A proof.auth script for a Next.js app whose local backend has demo accounts:
// it signs in as the seeded demo coach through "Try a demo account" on
// /cloud/login/, so UI proof shoots /cloud/** pages signed in. The session
// lives in localStorage, which the proof runner saves with the cookies.
//
// In the app's repo, as .rivetari/proof-auth.mjs, with:
//   proof:
//     start: npm run dev
//     ready_timeout: 180
//     auth:
//       script: .rivetari/proof-auth.mjs

const DB_KEY = "breathband-console:local-db";
const COACH = "demo-coach";

/** @param {{ page: import("playwright-core").Page }} args */
export default async function signIn({ page }) {
  await page.goto("/cloud/login/");
  const card = page.getByRole("button", { name: /Sign in as Lena Vos/ });
  // A click before React hydrates does nothing, and the dev server compiles
  // the page on first load: click until the sign-in takes.
  const deadline = Date.now() + 90_000;
  for (;;) {
    await card.click({ timeout: 30_000 });
    const signedIn = await page
      .waitForFunction(
        ([key, uid]) => {
          const db = globalThis.localStorage.getItem(key);
          return db !== null && JSON.parse(db).currentUid === uid;
        },
        [DB_KEY, COACH],
        { timeout: 3_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (signedIn) break;
    if (Date.now() > deadline)
      throw new Error("the demo coach's sign-in didn't take within 90s");
  }
  // The shell sends a signed-in visitor on from the login page.
  await page.waitForURL((url) => !url.pathname.startsWith("/cloud/login"), {
    timeout: 30_000,
  });
}
