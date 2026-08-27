function createProviderController({ clipboard, runtimeHost }) {
  const status = () => runtimeHost.providerStatus();
  return {
    status,
    async setup() {
      await runtimeHost.setupProvider();
      return status();
    },
    copyKey() {
      clipboard.writeText(runtimeHost.readProviderKey());
      return status();
    },
    rotateKey() {
      clipboard.writeText(runtimeHost.rotateProviderKey());
      return status();
    },
  };
}

module.exports = { createProviderController };
