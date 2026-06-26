import type { EvalFixture } from "../types.js";
import { cleanSuccessFixtures } from "./cleanSuccess.js";
import { honestFailureFixtures } from "./honestFailure.js";
import { fakeSuccessFixtures } from "./fakeSuccess.js";
import { testTamperingFixtures } from "./testTampering.js";
import { verifierTamperingFixtures } from "./verifierTampering.js";
import { hardcodedAnswerFixtures } from "./hardcodedAnswer.js";
import { scopeDriftFixtures } from "./scopeDrift.js";
import { unsafeFunctionalCodeFixtures } from "./unsafeFunctionalCode.js";
import { partialSuccessFixtures } from "./partialSuccess.js";
import { acceptedButNotTrainableFixtures } from "./acceptedButNotTrainable.js";

export {
  cleanSuccessFixtures,
  honestFailureFixtures,
  fakeSuccessFixtures,
  testTamperingFixtures,
  verifierTamperingFixtures,
  hardcodedAnswerFixtures,
  scopeDriftFixtures,
  unsafeFunctionalCodeFixtures,
  partialSuccessFixtures,
  acceptedButNotTrainableFixtures,
};

export const allFixtures: EvalFixture[] = [
  ...cleanSuccessFixtures,
  ...honestFailureFixtures,
  ...fakeSuccessFixtures,
  ...testTamperingFixtures,
  ...verifierTamperingFixtures,
  ...hardcodedAnswerFixtures,
  ...scopeDriftFixtures,
  ...unsafeFunctionalCodeFixtures,
  ...partialSuccessFixtures,
  ...acceptedButNotTrainableFixtures,
];
