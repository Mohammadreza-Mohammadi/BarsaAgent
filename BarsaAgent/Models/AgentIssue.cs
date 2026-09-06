using System.Collections.Generic;

namespace BarsaAgent.Models;

/// <summary>
/// یک ایشو بعد از اعمال Mapping، آماده برای مرحله ساخت Worktree.
/// معادل AgentTask در طراحی اصلی (id, title, description, acceptanceCriteria).
/// </summary>
public class AgentIssue
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public List<string> AcceptanceCriteria { get; set; } = new();

    /// <summary>اختیاری - برای ساخت اسلاگ برنچ (agent/{id}-{slug}).</summary>
    public string? Slug { get; set; }
}
