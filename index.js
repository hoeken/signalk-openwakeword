module.exports = function (app) {
  const plugin = {
    id: 'signalk-openwakeword',
    name: 'openWakeWord (Wyoming wake word)',
    description:
      'Wyoming openWakeWord wake word detection service for Signal K — pre-release placeholder, not yet functional.',

    schema: () => ({
      type: 'object',
      properties: {},
    }),

    start: (options) => {
      app.setPluginStatus(
        'Pre-release placeholder — not yet functional. See https://github.com/hoeken/signalk-wyoming'
      )
    },

    stop: () => {},
  }

  return plugin
}
