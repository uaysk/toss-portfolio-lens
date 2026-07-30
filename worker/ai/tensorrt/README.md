# FinCast TensorRT 8.6.1.6 challenger

This directory contains the FP32 top-2 routing/dispatch/combine plugin used by
the static INT8 challenger. It is deliberately separate from the production
worker image and targets only `sm_61`.

The plugin accepts FP32 softmax probabilities shaped `[B,16,4]` and explicit
stateless routing uniforms shaped `[2,B,16]`. It returns FP32 dispatch and
combine tensors shaped `[B,16,4,8]`. Expert and attention GEMMs stay outside
the plugin so TensorRT can select INT8 tactics for them; normalization,
softmax, routing, and final quantile restoration remain FP32.

Builds use the unpacked TensorRT 8.6.1.6 SDK, the worker's CUDA 12.2
toolkit, and system cuDNN 8.9.7:

```text
cmake -S worker/ai/tensorrt -B <temporary-build-dir> \
  -DTENSORRT_ROOT=<read-only-tensorrt-8.6.1.6-root>
cmake --build <temporary-build-dir> --parallel
```

The resulting shared library is a challenger artifact only. It is not copied
into the live FinCast image and does not authorize engine promotion.
