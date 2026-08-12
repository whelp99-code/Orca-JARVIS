import process from "node:process";

const expectedMajor = 24;
const expectedAbi = "137";
const actualMajor = Number(process.versions.node.split(".")[0]);
const actualAbi = process.versions.modules;

if (actualMajor !== expectedMajor || actualAbi !== expectedAbi) {
  process.stderr.write(`JARVIS_RUNTIME_MISMATCH expected=node${expectedMajor}/abi${expectedAbi} actual=${process.version}/abi${actualAbi}\n`);
  process.exit(64);
}
process.stdout.write(`JARVIS_RUNTIME_OK node=${process.version} abi=${actualAbi}\n`);
