#include <NvInfer.h>
#include <NvInferPlugin.h>
#include <cuda_runtime.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr char kPluginName[] = "FincastTop2Route";
constexpr char kPluginVersion[] = "1";
constexpr int32_t kTokens = 16;
constexpr int32_t kExperts = 4;
constexpr int32_t kCapacity = 8;
constexpr int32_t kTopN = 2;
constexpr float kDefaultThreshold = 0.2F;

template <typename T>
void writeValue(char*& destination, T const& value) noexcept {
  std::memcpy(destination, &value, sizeof(T));
  destination += sizeof(T);
}

template <typename T>
T readValue(char const*& source) noexcept {
  T value{};
  std::memcpy(&value, source, sizeof(T));
  source += sizeof(T);
  return value;
}

__global__ void routeKernel(
    float const* probabilities,
    float const* uniforms,
    float* dispatch,
    float* combine,
    int32_t batch,
    float threshold) {
  int32_t const batchIndex = static_cast<int32_t>(blockIdx.x);
  if (batchIndex >= batch || threadIdx.x != 0) {
    return;
  }

  constexpr int32_t outputPerBatch = kTokens * kExperts * kCapacity;
  int32_t const outputBase = batchIndex * outputPerBatch;
  for (int32_t index = 0; index < outputPerBatch; ++index) {
    dispatch[outputBase + index] = 0.0F;
    combine[outputBase + index] = 0.0F;
  }

  int32_t topExpert[kTopN][kTokens];
  float topWeight[kTopN][kTokens];
  bool routeSecond[kTokens];
  for (int32_t token = 0; token < kTokens; ++token) {
    int32_t const probabilityBase = (batchIndex * kTokens + token) * kExperts;
    int32_t first = 0;
    int32_t second = 1;
    if (probabilities[probabilityBase + second] > probabilities[probabilityBase + first]) {
      int32_t const temporary = first;
      first = second;
      second = temporary;
    }
    for (int32_t expert = 2; expert < kExperts; ++expert) {
      float const value = probabilities[probabilityBase + expert];
      if (value > probabilities[probabilityBase + first]) {
        second = first;
        first = expert;
      } else if (value > probabilities[probabilityBase + second]) {
        second = expert;
      }
    }
    float const sum = fmaxf(
        probabilities[probabilityBase + first] + probabilities[probabilityBase + second],
        1.0e-9F);
    topExpert[0][token] = first;
    topExpert[1][token] = second;
    topWeight[0][token] = probabilities[probabilityBase + first] / sum;
    topWeight[1][token] = probabilities[probabilityBase + second] / sum;
    int32_t const uniformIndex = (batch + batchIndex) * kTokens + token;
    routeSecond[token] = uniforms[uniformIndex] < topWeight[1][token] / threshold;
  }

  int32_t used[kExperts] = {0, 0, 0, 0};
  for (int32_t route = 0; route < kTopN; ++route) {
    for (int32_t token = 0; token < kTokens; ++token) {
      if (route == 1 && !routeSecond[token]) {
        continue;
      }
      int32_t const expert = topExpert[route][token];
      int32_t const position = used[expert]++;
      if (position >= kCapacity) {
        continue;
      }
      int32_t const outputIndex =
          outputBase + ((token * kExperts + expert) * kCapacity + position);
      dispatch[outputIndex] = 1.0F;
      combine[outputIndex] = topWeight[route][token];
    }
  }
}

class FincastTop2RoutePlugin final : public nvinfer1::IPluginV2DynamicExt {
 public:
  explicit FincastTop2RoutePlugin(float threshold = kDefaultThreshold) noexcept
      : threshold_(threshold) {}

  FincastTop2RoutePlugin(void const* data, size_t length) noexcept {
    if (length == sizeof(float)) {
      char const* cursor = static_cast<char const*>(data);
      threshold_ = readValue<float>(cursor);
    }
  }

  char const* getPluginType() const noexcept override { return kPluginName; }
  char const* getPluginVersion() const noexcept override { return kPluginVersion; }
  int32_t getNbOutputs() const noexcept override { return 2; }
  int32_t initialize() noexcept override { return 0; }
  void terminate() noexcept override {}
  size_t getSerializationSize() const noexcept override { return sizeof(float); }

  void serialize(void* buffer) const noexcept override {
    char* cursor = static_cast<char*>(buffer);
    writeValue(cursor, threshold_);
  }

  void destroy() noexcept override { delete this; }

  nvinfer1::IPluginV2DynamicExt* clone() const noexcept override {
    auto* plugin = new FincastTop2RoutePlugin(threshold_);
    plugin->setPluginNamespace(namespace_.c_str());
    return plugin;
  }

  void setPluginNamespace(char const* pluginNamespace) noexcept override {
    namespace_ = pluginNamespace == nullptr ? "" : pluginNamespace;
  }

  char const* getPluginNamespace() const noexcept override {
    return namespace_.c_str();
  }

  nvinfer1::DataType getOutputDataType(
      int32_t,
      nvinfer1::DataType const* inputTypes,
      int32_t) const noexcept override {
    return inputTypes[0];
  }

  void attachToContext(
      cudnnContext*,
      cublasContext*,
      nvinfer1::IGpuAllocator*) noexcept override {}

  void detachFromContext() noexcept override {}

  nvinfer1::DimsExprs getOutputDimensions(
      int32_t,
      nvinfer1::DimsExprs const* inputs,
      int32_t nbInputs,
      nvinfer1::IExprBuilder& expressionBuilder) noexcept override {
    nvinfer1::DimsExprs output{};
    if (nbInputs != 2 || inputs[0].nbDims != 3) {
      output.nbDims = 0;
      return output;
    }
    output.nbDims = 4;
    output.d[0] = inputs[0].d[0];
    output.d[1] = expressionBuilder.constant(kTokens);
    output.d[2] = expressionBuilder.constant(kExperts);
    output.d[3] = expressionBuilder.constant(kCapacity);
    return output;
  }

  bool supportsFormatCombination(
      int32_t position,
      nvinfer1::PluginTensorDesc const* inOut,
      int32_t nbInputs,
      int32_t nbOutputs) noexcept override {
    if (nbInputs != 2 || nbOutputs != 2 || position < 0 || position >= 4) {
      return false;
    }
    return inOut[position].type == nvinfer1::DataType::kFLOAT
        && inOut[position].format == nvinfer1::TensorFormat::kLINEAR;
  }

  void configurePlugin(
      nvinfer1::DynamicPluginTensorDesc const* inputs,
      int32_t nbInputs,
      nvinfer1::DynamicPluginTensorDesc const* outputs,
      int32_t nbOutputs) noexcept override {
    valid_ = nbInputs == 2
        && nbOutputs == 2
        && inputs[0].desc.dims.nbDims == 3
        && inputs[0].desc.dims.d[1] == kTokens
        && inputs[0].desc.dims.d[2] == kExperts
        && inputs[1].desc.dims.nbDims == 3
        && inputs[1].desc.dims.d[0] == kTopN
        && inputs[1].desc.dims.d[2] == kTokens
        && outputs[0].desc.dims.nbDims == 4
        && outputs[1].desc.dims.nbDims == 4;
  }

  size_t getWorkspaceSize(
      nvinfer1::PluginTensorDesc const*,
      int32_t,
      nvinfer1::PluginTensorDesc const*,
      int32_t) const noexcept override {
    return 0;
  }

  int32_t enqueue(
      nvinfer1::PluginTensorDesc const* inputDesc,
      nvinfer1::PluginTensorDesc const*,
      void const* const* inputs,
      void* const* outputs,
      void*,
      cudaStream_t stream) noexcept override {
    if (!valid_ || threshold_ <= 0.0F) {
      return 1;
    }
    int32_t const batch = inputDesc[0].dims.d[0];
    if (batch <= 0 || inputDesc[1].dims.d[1] != batch) {
      return 1;
    }
    routeKernel<<<batch, 1, 0, stream>>>(
        static_cast<float const*>(inputs[0]),
        static_cast<float const*>(inputs[1]),
        static_cast<float*>(outputs[0]),
        static_cast<float*>(outputs[1]),
        batch,
        threshold_);
    return cudaPeekAtLastError() == cudaSuccess ? 0 : 1;
  }

 private:
  float threshold_{kDefaultThreshold};
  bool valid_{false};
  std::string namespace_;
};

class FincastTop2RouteCreator final : public nvinfer1::IPluginCreator {
 public:
  FincastTop2RouteCreator() {
    fields_.emplace_back(
        nvinfer1::PluginField{
            "threshold",
            nullptr,
            nvinfer1::PluginFieldType::kFLOAT32,
            1});
    collection_.nbFields = static_cast<int32_t>(fields_.size());
    collection_.fields = fields_.data();
  }

  char const* getPluginName() const noexcept override { return kPluginName; }
  char const* getPluginVersion() const noexcept override { return kPluginVersion; }

  nvinfer1::PluginFieldCollection const* getFieldNames() noexcept override {
    return &collection_;
  }

  nvinfer1::IPluginV2* createPlugin(
      char const*,
      nvinfer1::PluginFieldCollection const* fields) noexcept override {
    float threshold = kDefaultThreshold;
    if (fields != nullptr) {
      for (int32_t index = 0; index < fields->nbFields; ++index) {
        nvinfer1::PluginField const& field = fields->fields[index];
        if (
            field.name != nullptr
            && std::strcmp(field.name, "threshold") == 0
            && field.type == nvinfer1::PluginFieldType::kFLOAT32
            && field.length == 1
            && field.data != nullptr) {
          std::memcpy(&threshold, field.data, sizeof(float));
        }
      }
    }
    return new FincastTop2RoutePlugin(threshold);
  }

  nvinfer1::IPluginV2* deserializePlugin(
      char const*,
      void const* serialData,
      size_t serialLength) noexcept override {
    return new FincastTop2RoutePlugin(serialData, serialLength);
  }

  void setPluginNamespace(char const* pluginNamespace) noexcept override {
    namespace_ = pluginNamespace == nullptr ? "" : pluginNamespace;
  }

  char const* getPluginNamespace() const noexcept override {
    return namespace_.c_str();
  }

 private:
  std::vector<nvinfer1::PluginField> fields_;
  nvinfer1::PluginFieldCollection collection_{};
  std::string namespace_;
};

}  // namespace

REGISTER_TENSORRT_PLUGIN(FincastTop2RouteCreator);
