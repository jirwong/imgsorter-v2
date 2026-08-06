import { main } from './cli';

main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
