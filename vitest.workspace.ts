import { defineWorkspace } from "vitest/config";

import config, { GIT_HEAVY_TESTS } from "./vitest.config";

const { include, exclude = [], testTimeout, hookTimeout } = config.test ?? {};

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include,
      exclude: [...exclude, ...GIT_HEAVY_TESTS],
      testTimeout,
      hookTimeout,
      pool: "forks",
    },
  },
  {
    test: {
      name: "git",
      include: GIT_HEAVY_TESTS,
      exclude,
      testTimeout,
      hookTimeout,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
