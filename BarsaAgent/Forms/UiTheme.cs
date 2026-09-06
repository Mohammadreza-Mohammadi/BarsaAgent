using System.Drawing;
using System.Windows.Forms;

namespace BarsaAgent.Forms;

internal static class UiTheme
{
    internal static readonly Color WindowBackground = Color.FromArgb(245, 247, 250);
    internal static readonly Color Surface = Color.White;
    internal static readonly Color Primary = Color.FromArgb(37, 99, 235);
    internal static readonly Color PrimaryHover = Color.FromArgb(29, 78, 216);
    internal static readonly Color TextPrimary = Color.FromArgb(31, 41, 55);
    internal static readonly Color TextSecondary = Color.FromArgb(75, 85, 99);
    internal static readonly Color Border = Color.FromArgb(209, 213, 219);
    internal static readonly Color Success = Color.FromArgb(22, 101, 52);
    internal static readonly Color Warning = Color.FromArgb(161, 98, 7);
    internal static readonly Color Error = Color.FromArgb(185, 28, 28);

    internal static void ApplyForm(Form form)
    {
        form.RightToLeft = RightToLeft.No;
        form.RightToLeftLayout = false;
        form.Font = new Font("Segoe UI", 9.5F);
        form.BackColor = WindowBackground;
        form.ForeColor = TextPrimary;
    }

    internal static void StylePrimaryButton(Button button)
    {
        StyleButtonBase(button);
        button.BackColor = Primary;
        button.ForeColor = Color.White;
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = PrimaryHover;
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(30, 64, 175);
        button.Font = new Font("Segoe UI Semibold", 9.5F, FontStyle.Bold);
    }

    internal static void StyleSecondaryButton(Button button)
    {
        StyleButtonBase(button);
        button.BackColor = Surface;
        button.ForeColor = TextPrimary;
        button.FlatAppearance.BorderColor = Border;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(239, 246, 255);
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(219, 234, 254);
        button.Font = new Font("Segoe UI Semibold", 9F, FontStyle.Bold);
    }

    private static void StyleButtonBase(Button button)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.Cursor = Cursors.Hand;
        button.UseVisualStyleBackColor = false;
        button.Padding = new Padding(10, 0, 10, 0);
    }

    internal static GroupBox CreateGroup(string text)
    {
        return new GroupBox
        {
            Text = text,
            Dock = DockStyle.Fill,
            BackColor = Surface,
            ForeColor = TextPrimary,
            Font = new Font("Segoe UI Semibold", 9.5F, FontStyle.Bold),
            Padding = new Padding(12, 10, 12, 12)
        };
    }

    internal static Label CreateFieldLabel(string text)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            ForeColor = TextSecondary,
            Font = new Font("Segoe UI", 9F)
        };
    }

    internal static void StyleInput(Control input)
    {
        input.Font = new Font("Segoe UI", 9.5F);
        input.Margin = new Padding(6, 5, 6, 5);
        input.Anchor = AnchorStyles.Left | AnchorStyles.Right;
    }

    internal static StatusStrip CreateStatusStrip(out ToolStripStatusLabel statusLabel, out ToolStripStatusLabel timeLabel)
    {
        var strip = new StatusStrip
        {
            SizingGrip = false,
            BackColor = Color.FromArgb(17, 24, 39),
            ForeColor = Color.White,
            Padding = new Padding(8, 0, 8, 0),
            RightToLeft = RightToLeft.No
        };

        statusLabel = new ToolStripStatusLabel
        {
            Text = "Ready",
            Spring = true,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 9F)
        };
        timeLabel = new ToolStripStatusLabel
        {
            Text = "",
            TextAlign = ContentAlignment.MiddleRight,
            ForeColor = Color.FromArgb(156, 163, 175),
            Font = new Font("Segoe UI", 8.5F)
        };

        strip.Items.Add(statusLabel);
        strip.Items.Add(timeLabel);
        return strip;
    }
}
