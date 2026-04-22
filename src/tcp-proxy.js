export class TcpProxy {
  constructor({ logger }) {
    this.logger = logger;
  }

  async forward(frame) {
    this.logger.info("TCP proxy forward", { bytes: Buffer.byteLength(String(frame || "")) });
    return null;
  }
}
