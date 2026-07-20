pub mod analytics;
pub mod backtest;
pub mod batch;
pub mod compute;
pub mod contracts;
pub mod control;
pub mod date;
pub mod indicators;
pub mod model;
pub mod monte_carlo;
pub mod optimization;
pub mod portfolio_math;
pub mod repository;
pub mod stats;
pub mod technical_strategy;

pub const ENGINE_VERSION: &str = "portfolio-lens-rust-2026.07.5";
pub const WORKER_SCHEMA_VERSION: &str = "1.0";
