export class CliError extends Error {
  readonly exitCode: 1 | 2 | 3;

  constructor(message: string, exitCode: 1 | 2 | 3) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
