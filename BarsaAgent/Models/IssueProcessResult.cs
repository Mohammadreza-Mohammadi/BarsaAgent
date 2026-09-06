namespace BarsaAgent.Models;

public enum ProcessStatus
{
    Success,
    AlreadyPrepared,
    Error
}

/// <summary>نتیجه‌ی آماده‌سازی Worktree برای یک ایشو خاص.</summary>
public class IssueProcessResult
{
    public AgentIssue Issue { get; set; } = null!;
    public ProcessStatus Status { get; set; }
    public string BranchName { get; set; } = "";
    public string WorktreePath { get; set; } = "";
    public string Message { get; set; } = "";
}
