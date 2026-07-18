use anyhow::Result;

/// A lightweight cooperative stop hook shared by the durable and socket runtimes.
///
/// Domain kernels call this only at deterministic safe boundaries. The default direct
/// execution path supplies no control, so benchmark and CLI execution avoid syscall or
/// atomic overhead when cancellation is not required.
pub trait ComputeControl: Sync {
    fn checkpoint(&self) -> Result<()>;
}

#[inline]
pub fn checkpoint(control: Option<&dyn ComputeControl>) -> Result<()> {
    if let Some(control) = control {
        control.checkpoint()?;
    }
    Ok(())
}
