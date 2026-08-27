function runtimeStartupPolicy(config) {
  const providerMode = config?.providerApi?.enabled === true;
  return {
    inspectRoute: !providerMode,
    restoreRouteOnFailure: !providerMode,
  };
}

module.exports = { runtimeStartupPolicy };
