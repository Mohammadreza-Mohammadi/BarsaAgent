namespace BarsaAgent.Models;

/// <summary>
/// نحوه استخراج Acceptance Criteria از پاسخ وب‌سرویس.
/// </summary>
public enum AcceptanceCriteriaMode
{
    /// <summary>مسیر مشخص‌شده یک آرایه JSON از رشته‌هاست.</summary>
    ArrayField,

    /// <summary>مسیر مشخص‌شده یک رشته‌ی متنی است که باید با یک جداکننده Split شود.</summary>
    SplitText
}

/// <summary>
/// نگاشت فیلدهای هدف (مدل داخلی Issue) به مسیرهای JSON (dot-notation) در پاسخ وب‌سرویس.
/// مسیرها نسبت به هر آیتم داخل آرایه‌ی ایشوها هستند، نه ریشه‌ی کل پاسخ.
/// مثال مسیر: "fields.title" یا "id".
/// </summary>
public class FieldMapping
{
    public string IdPath { get; set; } = "";
    public string TitlePath { get; set; } = "";
    public string DescriptionPath { get; set; } = "";

    public string AcceptanceCriteriaPath { get; set; } = "";
    public AcceptanceCriteriaMode AcceptanceCriteriaMode { get; set; } = AcceptanceCriteriaMode.SplitText;
    public string AcceptanceCriteriaDelimiter { get; set; } = "\n";

    /// <summary>اختیاری. اگر پر شود، برای ساخت اسلاگ برنچ گیت استفاده می‌شود.</summary>
    public string SlugPath { get; set; } = "";

    public bool IsComplete()
    {
        return !string.IsNullOrWhiteSpace(IdPath)
            && !string.IsNullOrWhiteSpace(TitlePath)
            && !string.IsNullOrWhiteSpace(AcceptanceCriteriaPath);
    }
}
