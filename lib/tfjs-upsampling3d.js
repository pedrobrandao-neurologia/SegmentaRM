// O tfjs Layers não traz UpSampling3D; esta implementação replica o comportamento
// do Keras (repetição nearest por eixo, channels_last) e se registra para a
// desserialização do LayersModel do SynthSeg. Mantém tudo em rank ≤ 4 por passo,
// dentro dos limites dos backends webgl/cpu.

export function registerUpSampling3D (tf) {
  if (registerUpSampling3D._done) return
  registerUpSampling3D._done = true

  class UpSampling3D extends tf.layers.Layer {
    constructor (config) {
      super(config || {})
      const size = (config && config.size) || [2, 2, 2]
      this.size = Array.isArray(size) ? size : [size, size, size]
    }

    computeOutputShape (inputShape) {
      return [
        inputShape[0],
        inputShape[1] == null ? null : inputShape[1] * this.size[0],
        inputShape[2] == null ? null : inputShape[2] * this.size[1],
        inputShape[3] == null ? null : inputShape[3] * this.size[2],
        inputShape[4]
      ]
    }

    call (inputs) {
      const tfjs = tf
      return tfjs.tidy(() => {
        let x = Array.isArray(inputs) ? inputs[0] : inputs
        for (let axis = 1; axis <= 3; axis++) {
          const rep = this.size[axis - 1]
          if (rep === 1) continue
          const s = x.shape
          const P = s.slice(0, axis).reduce((a, b) => a * b, 1)
          const n = s[axis]
          const Q = s.slice(axis + 1).reduce((a, b) => a * b, 1)
          const out = s.slice()
          out[axis] = n * rep
          x = x.reshape([P, n, 1, Q]).tile([1, 1, rep, 1]).reshape(out)
        }
        return x
      })
    }

    getConfig () {
      const config = super.getConfig()
      return Object.assign({}, config, { size: this.size, data_format: 'channels_last' })
    }

    static get className () { return 'UpSampling3D' }
  }
  Object.defineProperty(UpSampling3D, 'className', { value: 'UpSampling3D' })
  tf.serialization.registerClass(UpSampling3D)

  // BN congelado (inferência): afinidade por canal em qualquer rank — o
  // BatchNormalization nativo do tfjs não aceita tensores rank 5.
  class FrozenBatchNorm3D extends tf.layers.Layer {
    constructor (config) {
      super(config || {})
      this.epsilon = (config && config.epsilon != null) ? config.epsilon : 1e-3
    }

    build (inputShape) {
      const dim = inputShape[inputShape.length - 1]
      this.gamma = this.addWeight('gamma', [dim], 'float32', tf.initializers.ones(), undefined, false)
      this.beta = this.addWeight('beta', [dim], 'float32', tf.initializers.zeros(), undefined, false)
      this.movingMean = this.addWeight('moving_mean', [dim], 'float32', tf.initializers.zeros(), undefined, false)
      this.movingVariance = this.addWeight('moving_variance', [dim], 'float32', tf.initializers.ones(), undefined, false)
      this.built = true
    }

    computeOutputShape (inputShape) { return inputShape }

    call (inputs) {
      return tf.tidy(() => {
        const x = Array.isArray(inputs) ? inputs[0] : inputs
        const scale = this.gamma.read().div(tf.sqrt(this.movingVariance.read().add(this.epsilon)))
        return x.mul(scale).add(this.beta.read().sub(this.movingMean.read().mul(scale)))
      })
    }

    getConfig () {
      return Object.assign({}, super.getConfig(), { epsilon: this.epsilon })
    }

    static get className () { return 'FrozenBatchNorm3D' }
  }
  Object.defineProperty(FrozenBatchNorm3D, 'className', { value: 'FrozenBatchNorm3D' })
  tf.serialization.registerClass(FrozenBatchNorm3D)
}
