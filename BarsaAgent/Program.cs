using System;
using System.Windows.Forms;
using BarsaAgent.Forms;

namespace BarsaAgent;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
