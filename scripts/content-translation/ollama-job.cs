using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class TranslationOllamaJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, BufferWidth, BufferHeight, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo Startup;
        public IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributes, uint count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr kind,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("iphlpapi.dll")]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, uint family, int kind, uint reserved);

    private static IntPtr InheritStandardHandle(int kind)
    {
        IntPtr copy;
        IntPtr self = GetCurrentProcess();
        if (!DuplicateHandle(self, GetStdHandle(kind), self, out copy, 0, true, 2))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot redirect Ollama pipes");
        return copy;
    }

    private static bool OwnsListener(uint processId, int port)
    {
        uint size = 0;
        uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
        if (result != 122 && result != 0) throw new Win32Exception((int)result);
        // The table can grow between sizing and copying; retry on the next poll.
        IntPtr table = Marshal.AllocHGlobal(checked((int)size));
        try
        {
            uint capacity = size;
            result = GetExtendedTcpTable(table, ref size, false, 2, 3, 0);
            if (result == 122) return false;
            if (result != 0) throw new Win32Exception((int)result);
            int count = Marshal.ReadInt32(table);
            if (count < 0 || 4L + 24L * count > capacity)
                throw new InvalidOperationException("Invalid TCP owner table");
            for (int index = 0; index < count; index++)
            {
                IntPtr row = IntPtr.Add(table, 4 + 24 * index);
                uint address = unchecked((uint)Marshal.ReadInt32(row, 4));
                uint encodedPort = unchecked((uint)Marshal.ReadInt32(row, 8));
                int localPort = (int)(((encodedPort & 255) << 8) | ((encodedPort >> 8) & 255));
                uint owner = unchecked((uint)Marshal.ReadInt32(row, 20));
                if (owner == processId && address == 0x0100007f && localPort == port) return true;
            }
            return false;
        }
        finally { Marshal.FreeHGlobal(table); }
    }

    private static void StopJob(IntPtr job)
    {
        if (!TerminateJobObject(job, 1))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot terminate the Ollama job");
        Stopwatch elapsed = Stopwatch.StartNew();
        do
        {
            Accounting accounting;
            if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify Ollama job cleanup");
            if (accounting.ActiveProcesses == 0) return;
            Thread.Sleep(25);
        } while (elapsed.ElapsedMilliseconds < 5000);
        throw new TimeoutException("Ollama job processes did not exit within 5 seconds");
    }

    /// <summary>Contain one Ollama service until the command closes its control pipe.</summary>
    /// <param name="executable">Resolved local Ollama executable path.</param>
    /// <param name="port">Requested IPv4 loopback listener port.</param>
    /// <returns>Zero after confirmed cleanup, or one after a startup or lifecycle failure.</returns>
    public static int Run(string executable, int port)
    {
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero, pipeList = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        bool attributesInitialized = false;
        try
        {
            if (port < 1 || port > 65535) throw new ArgumentOutOfRangeException("port");
            Console.WriteLine("{\"event\":\"ready\"}");
            // No executable starts if cancellation closes stdin during compilation.
            if (Console.ReadLine() != "start")
            {
                Console.WriteLine("{\"event\":\"stopped\"}");
                return 0;
            }
            Task<string> control = Task.Factory.StartNew(() => Console.ReadLine());
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create Ollama job");
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // Kill on last handle close; never allow breakaway.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot set Ollama job limits");
            input = InheritStandardHandle(-10);
            output = InheritStandardHandle(-12);
            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
            if (attributeSize == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot size process attributes");
            attributes = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot initialize process attributes");
            attributesInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000d), jobList,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot set Ollama job at creation (requires Windows 10 or later)");
            // Only the redirected pipes may be inherited, never unrelated supervisor handles.
            pipeList = Marshal.AllocHGlobal(2 * IntPtr.Size);
            Marshal.WriteIntPtr(pipeList, input);
            Marshal.WriteIntPtr(pipeList, IntPtr.Size, output);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), pipeList,
                new IntPtr(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot restrict inherited Ollama handles");
            StartupInfoEx startup = new StartupInfoEx();
            startup.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = 0x100;
            startup.Startup.Input = input;
            startup.Startup.Output = startup.Startup.Error = output;
            startup.Attributes = attributes;
            // Assign atomically: a supervisor crash must not leave an uncontained child.
            if (!CreateProcess(executable, new StringBuilder("\"" + executable + "\" serve"),
                IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, null, ref startup, out child))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot start ollama serve");
            bool listening = false;
            while (!control.IsCompleted)
            {
                uint state = WaitForSingleObject(child.Process, 50);
                if (state == 0)
                {
                    uint code;
                    if (!GetExitCodeProcess(child.Process, out code))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    throw new InvalidOperationException("ollama serve exited unexpectedly (" + code + ")");
                }
                if (state != 258) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot monitor Ollama");
                // A held process handle prevents PID reuse while checking listener ownership.
                if (!listening && OwnsListener(child.ProcessId, port))
                {
                    if (WaitForSingleObject(child.Process, 0) != 258) continue;
                    listening = true;
                    Console.WriteLine("{\"event\":\"listening\"}");
                }
            }
            StopJob(job);
            Console.WriteLine("{\"event\":\"stopped\"}");
            return 0;
        }
        catch (Exception error)
        {
            Win32Exception native = error as Win32Exception;
            Console.Error.WriteLine("Ollama supervisor: " + error.Message +
                (native == null ? "" : " (Windows error " + native.NativeErrorCode + ")"));
            try
            {
                if (job != IntPtr.Zero) StopJob(job);
                Console.WriteLine("{\"event\":\"stopped\"}");
            }
            catch (Exception cleanup) { Console.Error.WriteLine("Ollama cleanup: " + cleanup.Message); }
            return 1;
        }
        finally
        {
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (pipeList != IntPtr.Zero) Marshal.FreeHGlobal(pipeList);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
        }
    }
}
