cmake_minimum_required(VERSION 3.22)
project(fincast_tensorrt_plugins LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_ARCHITECTURES 61)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT DEFINED TENSORRT_ROOT)
  message(FATAL_ERROR "TENSORRT_ROOT must identify the unpacked TensorRT 8.6.1.6 directory")
endif()

find_path(TENSORRT_INCLUDE_DIR NvInfer.h
  PATHS "${TENSORRT_ROOT}/include"
  NO_DEFAULT_PATH
  REQUIRED
)
find_library(TENSORRT_NVINFER_LIBRARY nvinfer
  PATHS "${TENSORRT_ROOT}/lib" "${TENSORRT_ROOT}/lib64"
  NO_DEFAULT_PATH
  REQUIRED
)

add_library(fincast_trt_plugins SHARED fincast_top2_route_plugin.cu)
target_include_directories(fincast_trt_plugins PRIVATE "${TENSORRT_INCLUDE_DIR}")
target_link_libraries(fincast_trt_plugins PRIVATE "${TENSORRT_NVINFER_LIBRARY}")
target_compile_options(fincast_trt_plugins PRIVATE
  $<$<COMPILE_LANGUAGE:CXX>:-Wall;-Wextra>
  $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr;-Xcompiler=-Wall,-Wextra>
)
set_target_properties(fincast_trt_plugins PROPERTIES
  OUTPUT_NAME "fincast_trt_plugins"
  CUDA_SEPARABLE_COMPILATION ON
)
